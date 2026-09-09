import type { Config } from "#modules/configuration/index.js";
import { getFinalImage } from "#modules/sandbox-images/index.js";
import { CACHE_VOLUME } from "#modules/sandbox-resources/index.js";
import { getSandboxSettings } from "#modules/sandbox-settings/index.js";
import {
  getPersistentMounts,
  mountToDockerArg,
} from "#modules/storage/index.js";
import type { ContainerRuntime } from "#platform/container-runtime/index.js";
import { detectX11 } from "#platform/environment/index.js";
import {
  getExternalWorktreePath,
  type RepositoryRoots,
} from "#platform/git/index.js";
import { getLogger } from "#platform/logging/index.js";
import {
  resolveContainerPath,
  windowsPathToDocker,
} from "#shared/text/index.js";
import { getContainerDisplay } from "../container-display.js";
import { SANDBOX_PROJECT_LABEL } from "../container-labels.js";
import { convertMountForDocker } from "../mount-path-conversion.js";
import { validateMountPath } from "../mount-validation.js";
import {
  addIdeBridgePortEnvironment,
  logEnvironmentVariables,
} from "./environment-arguments.js";
import {
  addNamedVolumeMounts,
  addPersistMounts,
  logCustomMounts,
  logMounts,
} from "./mount-arguments.js";
import { addNetworkArguments, addPortArguments } from "./network-arguments.js";

// ---------------------------------------------------------------------------
// Shared option types
// ---------------------------------------------------------------------------

type ContainerArgumentRuntime = Pick<
  ContainerRuntime,
  "runtime" | "getHostInternalDns" | "getRuntimeRunFlags"
>;

interface BuildContainerArgsOptions {
  config: Config;
  projectRoot: string;
  currentDir: string; // Used for worktree detection
  projectSlug: string;
  repositoryRoots: RepositoryRoots;
}

interface ContainerDirectMount {
  readonly containerPath: string;
  readonly mode: "ro" | "rw";
}

function parseCustomDirectMount(mount: string): ContainerDirectMount {
  const parts = convertMountForDocker(mount).split(":");
  return {
    containerPath: parts.slice(1, -1).join(":"),
    mode: parts.at(-1) === "rw" ? "rw" : "ro",
  };
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

/**
 * Configure X11 forwarding for clipboard support
 */
async function configureX11(
  args: string[],
  service: ContainerArgumentRuntime,
): Promise<void> {
  const logger = getLogger();
  const x11Config = await detectX11();
  if (x11Config.available) {
    const display = getContainerDisplay(service, x11Config);
    if (display) {
      args.push("-e", `DISPLAY=${display}`);
      args.push("-e", "X11_AVAILABLE=true");
      logger.debug(`X11 forwarding enabled: DISPLAY=${display}`);

      // Linux: mount X11 socket
      if (x11Config.platform === "linux" && x11Config.socketPath) {
        args.push("-v", `${x11Config.socketPath}:/tmp/.X11-unix:ro`);
        logger.debug(`X11 socket mounted: ${x11Config.socketPath}`);
      }
    } else {
      args.push("-e", "X11_AVAILABLE=false");
      logger.debug("X11 detected but container display unavailable");
    }
  } else {
    args.push("-e", "X11_AVAILABLE=false");
    logger.debug("X11 not available");
  }
}

// ---------------------------------------------------------------------------
// Internal shared builders
// ---------------------------------------------------------------------------

/**
 * Build structural args for container creation.
 *
 * Includes: project label, workspace mount, worktree mount, container env,
 * X11, firewall, persistent/settings mounts, cache, custom mounts, ports.
 *
 * Does NOT include: --name, --label sandbox.hash, image,
 * working directory (-w), passthrough env vars, SANDBOX_DEBUG.
 */
async function buildStructuralArgs(
  service: ContainerArgumentRuntime,
  options: BuildContainerArgsOptions,
): Promise<string[]> {
  const { config, projectRoot, currentDir, projectSlug, repositoryRoots } =
    options;
  const logger = getLogger();
  const args: string[] = [];

  // Project label
  args.push("--label", `${SANDBOX_PROJECT_LABEL}=${projectSlug}`);
  logger.debug(`Project label: ${SANDBOX_PROJECT_LABEL}=${projectSlug}`);

  // Validate container path is safe
  validateMountPath(projectRoot);

  // Ensure projectRoot is absolute (Docker requires absolute container paths)
  if (!projectRoot.startsWith("/") && !/^[A-Za-z]:/.test(projectRoot)) {
    throw new Error(
      `Project root must be an absolute path, got: "${projectRoot}".\n` +
        "This is a bug. Please report it with your project's git configuration.",
    );
  }

  // Workspace mount
  const workspaceMode = config.readonly ? "ro" : "rw";
  const dockerProjectRoot = windowsPathToDocker(projectRoot);
  args.push("-v", `${dockerProjectRoot}:${dockerProjectRoot}:${workspaceMode}`);
  logger.debug(
    `Workspace mount: ${dockerProjectRoot}:${dockerProjectRoot}:${workspaceMode}`,
  );

  // External worktree mount (if in a worktree outside main repo)
  const externalWorktree = await getExternalWorktreePath(
    currentDir,
    repositoryRoots,
  );
  if (externalWorktree) {
    const dockerWorktreePath = windowsPathToDocker(externalWorktree);
    args.push(
      "-v",
      `${dockerWorktreePath}:${dockerWorktreePath}:${workspaceMode}`,
    );
    logger.debug(
      `External worktree mount: ${dockerWorktreePath}:${dockerWorktreePath}:${workspaceMode}`,
    );
  }

  // Fixed environment variables
  args.push("-e", "SANDBOX=1");

  // User-defined environment variables from config
  for (const env of config.env) {
    args.push("-e", env);
  }

  // The host-selected bridge port is structural and must not be overridden by
  // project configuration.
  const idePort = addIdeBridgePortEnvironment(args);

  // Log all container-level env vars
  const allContainerEnv = [
    "SANDBOX=1",
    ...config.env,
    ...(idePort ? [`CLAUDE_CODE_SSE_PORT=${idePort}`] : []),
  ];
  logEnvironmentVariables(allContainerEnv);

  // X11 clipboard support
  await configureX11(args, service);

  // Runtime-specific flags (cap-add, sysctl, ulimit, dns, etc.)
  const runtimeFlags = service.getRuntimeRunFlags({ shmSize: config.shmSize });
  args.push(...runtimeFlags);

  // Set SANDBOX_RUNTIME env var so entrypoint can detect the runtime
  args.push("-e", `SANDBOX_RUNTIME=${service.runtime}`);

  addNetworkArguments(args, config);

  // Persistent and settings mounts
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
  const customMounts = config.mounts.map(parseCustomDirectMount);
  const preparedSettings = await getSandboxSettings().createContainerSetup({
    entries: config.settings,
    persistentMounts: persistentResult.mounts,
    directMounts: [...namedVolumeMounts, ...customMounts],
  });
  logger.endTiming("Fetch mounts");

  for (const [name, value] of Object.entries(preparedSettings.environment)) {
    args.push("-e", `${name}=${value}`);
  }
  logger.debug(`Settings entries: ${config.settings.length} defined`);
  addPersistMounts(args, persistentResult);

  logMounts([...preparedSettings.mounts], "Settings mounts");
  for (const mount of preparedSettings.mounts) {
    args.push("-v", mountToDockerArg(mount));
  }

  // Cache volume
  args.push("-v", `${CACHE_VOLUME}:/var/cache`);
  logger.debug(`Cache volume: ${CACHE_VOLUME}:/var/cache`);

  // Named volumes from persist_paths with use_named_volume set
  addNamedVolumeMounts(args, config);

  // Custom mounts
  logCustomMounts(config.mounts, "Custom mounts");
  for (const mount of config.mounts) {
    const dockerMount = convertMountForDocker(mount);
    args.push("-v", dockerMount);
  }

  // Port mappings
  addPortArguments(args, config.ports);

  return args;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Result from buildContainerArgs, containing both the args array
 * and the resolved image name (avoiding fragile positional indexing).
 */
interface ContainerArgsResult {
  args: string[];
  imageName: string;
}

/**
 * Build container creation args (`docker run -d`).
 *
 * Returns the body args (everything after `run -d`) WITHOUT:
 * - `--name` (added by findOrCreateContainer / createFreshContainer)
 * - `--label sandbox.hash=...` (added by findOrCreateContainer)
 *
 * Ends with: `<image>` (entrypoint handles PID 1 lifecycle)
 */
export async function buildContainerArgs(
  service: ContainerArgumentRuntime,
  options: BuildContainerArgsOptions,
): Promise<ContainerArgsResult> {
  const { config, projectRoot, currentDir, projectSlug, repositoryRoots } =
    options;
  const logger = getLogger();

  logger.startTiming("Build container args");

  const structuralArgs = await buildStructuralArgs(service, {
    config,
    projectRoot,
    currentDir,
    projectSlug,
    repositoryRoots,
  });

  // Final image (entrypoint's idle watcher is PID 1, CMD is unused)
  const imageName = getFinalImage(projectRoot);
  const args = [...structuralArgs, imageName];

  logger.endTiming("Build container args");
  return { args, imageName };
}
