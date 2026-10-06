import type { Config } from "#modules/configuration/index.js";
import { getFinalImage } from "#modules/sandbox-images/index.js";
import {
  CACHE_VOLUME,
  ensureRuntimeStorage,
  getNamedVolumeName,
} from "#modules/sandbox-resources/index.js";
import {
  type CachedSandboxPackage,
  SANDBOX_RUNTIME_LABEL,
} from "#modules/sandbox-runtime/index.js";
import { getSandboxSettings } from "#modules/sandbox-settings/index.js";
import { getPersistentMounts } from "#modules/storage/index.js";
import type {
  PublishedPort,
  SandboxInstanceSpec,
  SandboxMount,
  SandboxStorageOperations,
} from "#platform/container-runtime/index.js";
import { detectX11 } from "#platform/environment/index.js";
import {
  getExternalWorktreePath,
  type RepositoryRoots,
} from "#platform/git/index.js";
import { getLogger } from "#platform/logging/index.js";
import {
  resolveContainerPath,
  splitColonString,
  windowsPathToDocker,
} from "#shared/text/index.js";
import { getContainerDisplay } from "../container-display.js";
import { SANDBOX_PROJECT_LABEL } from "../container-labels.js";
import {
  validateMountPath,
  validateProtectedMountPaths,
} from "../mount-validation.js";
import {
  addIdeBridgePortEnvironment,
  logEnvironmentVariables,
} from "./environment-arguments.js";
import { logCustomMounts, logMounts } from "./mount-arguments.js";

interface SandboxInstanceSpecRuntime {
  readonly runtime: "apple-container" | "docker" | "podman";
  readonly hostAccessName: string;
  readonly storage: SandboxStorageOperations;
}

interface BuildSandboxInstanceSpecOptions {
  readonly runtimePackage: CachedSandboxPackage;
  readonly config: Config;
  readonly projectRoot: string;
  readonly currentDir: string;
  readonly projectSlug: string;
  readonly repositoryRoots: RepositoryRoots;
}

function parseMount(value: string): SandboxMount {
  const parts = splitColonString(value);
  const source = parts[0];
  const target = parts[1];
  if (!source || !target) throw new Error(`Invalid container mount: ${value}`);
  return {
    type: "workspace",
    sourcePath: source,
    targetPath: windowsPathToDocker(target),
    readOnly: parts[2] !== "rw",
  };
}

function parsePortRange(value: string): number[] {
  const [firstText, lastText] = value.split("-", 2);
  const first = Number(firstText);
  const last = lastText ? Number(lastText) : first;
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    first < 1 ||
    last > 65_535 ||
    first > last
  ) {
    throw new Error(`Invalid published port range: ${value}`);
  }
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function parsePublishedPorts(value: string): PublishedPort[] {
  const [mapping, protocolText] = value.split("/", 2);
  const protocol = protocolText ?? "tcp";
  if (protocol !== "tcp" && protocol !== "udp") {
    throw new Error(`Invalid published port protocol: ${value}`);
  }
  const parts = mapping?.split(":") ?? [];
  const containerRange = parsePortRange(parts.at(-1) ?? "");
  const hostRange = parsePortRange(parts.at(-2) ?? parts.at(-1) ?? "");
  if (hostRange.length !== containerRange.length) {
    throw new Error(`Published port ranges must have equal lengths: ${value}`);
  }
  const hostAddress =
    parts.length > 2 ? parts.slice(0, -2).join(":") : undefined;
  return hostRange.map((hostPort, index) => ({
    ...(hostAddress ? { hostAddress } : {}),
    hostPort,
    instancePort: containerRange[index] as number,
    protocol,
  }));
}

async function addX11(
  runtime: SandboxInstanceSpecRuntime,
  environment: Record<string, string>,
  mounts: SandboxMount[],
): Promise<void> {
  const logger = getLogger();
  const x11Config = await detectX11();
  if (!x11Config.available) {
    environment.X11_AVAILABLE = "false";
    logger.debug("X11 not available");
    return;
  }
  const display = getContainerDisplay(runtime.hostAccessName, x11Config);
  if (!display) {
    environment.X11_AVAILABLE = "false";
    logger.debug("X11 detected but container display unavailable");
    return;
  }
  environment.DISPLAY = display;
  environment.X11_AVAILABLE = "true";
  logger.debug("Startup X11 forwarding enabled");
  if (x11Config.platform === "linux" && x11Config.socketPath) {
    mounts.push({
      type: "workspace",
      sourcePath: x11Config.socketPath,
      targetPath: "/tmp/.X11-unix",
      readOnly: true,
    });
  }
}

export async function buildSandboxInstanceSpec(
  runtime: SandboxInstanceSpecRuntime,
  options: BuildSandboxInstanceSpecOptions,
): Promise<SandboxInstanceSpec> {
  const { config, projectRoot, currentDir, projectSlug, repositoryRoots } =
    options;
  const logger = getLogger();
  logger.startTiming("Build container specification");

  validateMountPath(projectRoot);
  if (!projectRoot.startsWith("/") && !/^[A-Za-z]:/u.test(projectRoot)) {
    throw new Error(
      `Project root must be an absolute path, got: "${projectRoot}".\n` +
        "This is a bug. Please report it with your project's git configuration.",
    );
  }

  const targetProjectRoot = windowsPathToDocker(projectRoot);
  const workspaceReadOnly = config.readonly;
  const mounts: SandboxMount[] = [
    {
      type: "workspace",
      sourcePath: projectRoot,
      targetPath: targetProjectRoot,
      readOnly: workspaceReadOnly,
    },
  ];
  const externalWorktree = await getExternalWorktreePath(
    currentDir,
    repositoryRoots,
  );
  if (externalWorktree) {
    mounts.push({
      type: "workspace",
      sourcePath: externalWorktree,
      targetPath: windowsPathToDocker(externalWorktree),
      readOnly: workspaceReadOnly,
    });
  }

  const environment: Record<string, string> = {
    SANDBOX: "1",
    SANDBOX_RUNTIME: runtime.runtime,
    SANDBOX_HOST_ACCESS_NAME: runtime.hostAccessName,
  };
  const idePort = addIdeBridgePortEnvironment([]);
  if (idePort) environment.CLAUDE_CODE_SSE_PORT = idePort;
  await addX11(runtime, environment, mounts);

  const networkPolicy = {
    enabled: true,
    fullNetwork: config.fullNetwork,
    noProxy: config.noProxy,
    allowNetwork: config.allowNetwork,
  };
  environment.SANDBOX_FIREWALL = JSON.stringify(networkPolicy);
  if (config.noProxy) environment.SANDBOX_NO_PROXY = "1";

  logger.startTiming("Fetch mounts");
  const persistentResult = await getPersistentMounts(
    projectRoot,
    config.persistPaths,
  );
  const namedVolumeMounts = config.persistPaths
    .filter((entry) => entry.useNamedVolume !== undefined)
    .map((entry) => ({
      containerPath: resolveContainerPath(entry.path, "/home/sandbox"),
      mode: "rw" as const,
    }));
  const customMounts = config.mounts.map(parseMount);
  const preparedSettings = await getSandboxSettings().createContainerSetup({
    entries: config.settings,
    persistentMounts: persistentResult.mounts,
    directMounts: [
      ...namedVolumeMounts,
      ...customMounts.map((mount) => ({
        containerPath: mount.targetPath,
        mode: mount.readOnly ? ("ro" as const) : ("rw" as const),
      })),
      {
        containerPath: options.runtimePackage.mount.containerPath,
        mode: "ro",
      },
    ],
  });
  logger.endTiming("Fetch mounts");

  validateProtectedMountPaths(options.runtimePackage.mount.containerPath, [
    targetProjectRoot,
    ...(externalWorktree ? [windowsPathToDocker(externalWorktree)] : []),
    ...persistentResult.mounts.map((mount) => mount.containerPath),
    ...preparedSettings.mounts.map((mount) => mount.containerPath),
    ...namedVolumeMounts.map((mount) => mount.containerPath),
    ...customMounts.map((mount) => mount.targetPath),
  ]);
  Object.assign(environment, preparedSettings.environment);

  logMounts(persistentResult.mounts, "Persistent mounts");
  mounts.push(
    ...persistentResult.mounts.map((mount) => ({
      type: "workspace" as const,
      sourcePath: mount.hostPath,
      targetPath: mount.containerPath,
      readOnly: mount.mode === "ro",
    })),
  );
  logMounts([...preparedSettings.mounts], "Settings mounts");
  const cacheStorage = await ensureRuntimeStorage(runtime, {
    key: CACHE_VOLUME,
    scope: "global",
  });
  mounts.push(
    ...preparedSettings.mounts.map((mount) => ({
      type: "workspace" as const,
      sourcePath: mount.hostPath,
      targetPath: mount.containerPath,
      readOnly: mount.mode === "ro",
    })),
    {
      type: "storage",
      storage: cacheStorage,
      targetPath: "/var/cache",
      readOnly: false,
    },
  );
  for (const persistPath of config.persistPaths) {
    if (!persistPath.useNamedVolume) continue;
    const storage = await ensureRuntimeStorage(runtime, {
      key: getNamedVolumeName(persistPath.useNamedVolume),
      scope: "global",
    });
    mounts.push({
      type: "storage",
      storage,
      targetPath: resolveContainerPath(persistPath.path, "/home/sandbox"),
      readOnly: false,
    });
  }
  logCustomMounts(config.mounts, "Custom mounts");
  mounts.push(...customMounts, {
    type: "workspace",
    sourcePath: options.runtimePackage.mount.hostPath,
    targetPath: options.runtimePackage.mount.containerPath,
    readOnly: true,
  });

  logEnvironmentVariables(
    "Startup",
    Object.entries(environment).map(([name, value]) => `${name}=${value}`),
  );
  const spec: SandboxInstanceSpec = {
    name: "",
    image: { reference: getFinalImage(projectRoot), digest: "" },
    labels: {
      [SANDBOX_PROJECT_LABEL]: projectSlug,
      [SANDBOX_RUNTIME_LABEL]: options.runtimePackage.id,
    },
    environment,
    mounts,
    ports: config.ports.flatMap(parsePublishedPorts),
    init: true,
    removeOnExit: true,
    resources: {
      ...(config.shmSize ? { sharedMemorySize: config.shmSize } : {}),
    },
    security: { capabilities: ["NET_ADMIN"], nestedContainerRuntime: false },
  };
  logger.endTiming("Build container specification");
  return spec;
}
