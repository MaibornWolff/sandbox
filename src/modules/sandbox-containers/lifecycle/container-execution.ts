import { normalize } from "node:path";
import chalk from "chalk";
import {
  type Config,
  getConfigurationService,
} from "#modules/configuration/index.js";
import {
  HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE,
  startHostCommandEscapeSession,
} from "#modules/host-command-escape/index.js";
import { allowHostCommandNetworkAccess } from "#modules/network/index.js";
import type { BuildImagesResult } from "#modules/sandbox-images/index.js";
import {
  cleanupSandboxRuntimeAfterSession,
  prepareSandboxRuntime,
} from "#modules/sandbox-runtime/index.js";
import type {
  SandboxInstanceSpec,
  SandboxRuntime,
} from "#platform/container-runtime/index.js";
import { getRuntimeProvider } from "#platform/container-runtime/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { readPackageVersion } from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import { confirmDestruction, getTerminal } from "#platform/terminal/index.js";
import {
  generateProjectSlug,
  normalizePath,
  windowsPathToDocker,
} from "#shared/text/index.js";
import { buildSandboxInstanceSpec } from "../arguments/container-arguments.js";
import { validateConfiguredEnvironment } from "../arguments/environment-arguments.js";
import { buildSandboxExecSpec } from "../arguments/session-arguments.js";
import { computeRuntimeContainerHash } from "../container-hashing.js";
import type { SandboxContext } from "../sandbox-context.js";
import type { SandboxOptions } from "../sandbox-options.js";
import {
  createFreshContainer,
  findOrCreateContainer,
  pickFreshContainerName,
  waitForReady,
} from "./container-reuse.js";
import { resolveHostAgentTitle } from "./host-agent-title.js";
import {
  prepareSandboxEnvironment,
  warnIfX11Unavailable,
} from "./sandbox-preparation.js";
import { captureStartupLogs } from "./startup-logs.js";

interface ExecutorOptions {
  readonly command: string[];
  readonly stdin: boolean;
  readonly tty: boolean;
  readonly timingLabel?: string;
  readonly beforeSpawn?: (config: Config) => void;
  readonly foreground?: boolean;
}

class SandboxExecutionExitError extends Error {
  readonly reported = true;

  constructor(readonly exitCode: number) {
    super(`Sandbox child exited with code ${exitCode}`);
  }
}

function writeOutput(message = ""): void {
  getTerminal().stdout.write(`${message}\n`);
}

function throwForChildExit(exitCode: number): void {
  if (exitCode !== 0) throw new SandboxExecutionExitError(exitCode);
}

async function runForegroundContainer(
  service: SandboxRuntime,
  options: {
    readonly containerSpec: SandboxInstanceSpec;
    readonly projectSlug: string;
  },
): Promise<void> {
  const containerName = await pickFreshContainerName(
    service,
    options.projectSlug,
  );
  const spec: SandboxInstanceSpec = {
    ...options.containerSpec,
    name: containerName,
    removeOnExit: false,
  };
  getLogger().endTiming("Container setup");
  writeOutput(
    chalk.cyan(
      `Starting container ${chalk.bold(containerName)} in foreground (Ctrl+C to stop)...`,
    ),
  );
  writeOutput(
    chalk.dim(
      "Container will NOT be auto-removed. Clean up with: sandbox clean",
    ),
  );
  writeOutput();

  const result = await service.instances.runAttached(spec, {
    attachStdin: false,
    allocateTerminal: false,
  });
  if (result.exitCode !== 0) {
    writeOutput();
    writeOutput(chalk.yellow("Container stopped. Inspect with:"));
    writeOutput(chalk.dim(`  sandbox logs ${containerName}`));
    writeOutput(chalk.dim("  sandbox status"));
    writeOutput(chalk.dim("  sandbox clean"));
  }
  throwForChildExit(result.exitCode);
}

async function resolveExecutionContainer(
  service: SandboxRuntime,
  options: {
    readonly containerSpec: SandboxInstanceSpec;
    readonly imageIdentity: string;
    readonly projectSlug: string;
    readonly skipReuse: boolean;
  },
): Promise<{ readonly containerName: string; readonly created: boolean }> {
  const logger = getLogger();
  if (options.skipReuse) {
    return {
      containerName: await createFreshContainer(
        service,
        options.projectSlug,
        options.containerSpec,
      ),
      created: true,
    };
  }

  const imageIdentity =
    options.imageIdentity || options.containerSpec.image.digest;
  if (!imageIdentity) {
    logger.error(
      `Failed to get immutable image identity. Run 'sandbox build' first.`,
    );
    throw new SandboxExecutionExitError(1);
  }

  const version = readPackageVersion();
  const hash = await computeRuntimeContainerHash({
    version,
    service,
    imageIdentity,
    spec: options.containerSpec,
  });
  logger.debug(
    `Container hash: ${hash} (version=${version}, image=${options.containerSpec.image.digest}, runtime=${service.runtime})`,
  );
  let result = await findOrCreateContainer(
    service,
    options.projectSlug,
    hash,
    options.containerSpec,
  );

  if (!result.created) {
    try {
      await waitForReady(service, result.containerName, 5_000);
      logger.debug(`Reusing existing container: ${result.containerName}`);
    } catch {
      logger.debug(
        `Reused container ${result.containerName} stopped, creating new one`,
      );
      result = await findOrCreateContainer(
        service,
        options.projectSlug,
        hash,
        options.containerSpec,
      );
      return { ...result, created: true };
    }
  }
  return result;
}

async function execute(
  service: SandboxRuntime,
  ctx: SandboxContext,
  executorOptions: ExecutorOptions,
  verbose: boolean,
  skipReuse: boolean,
  buildResult: BuildImagesResult,
): Promise<void> {
  const logger = getLogger();
  const environment = getHostEnvironment();
  const { command, stdin, tty, foreground } = executorOptions;
  const { config, projectRoot, repositoryRoots } = ctx;
  const currentDir = environment.currentWorkingDirectory;
  const projectSlug = generateProjectSlug(projectRoot);
  const hostInfo = await service.ensureHostReady();

  logger.startTiming("Container setup");
  await using runtimePackage = await prepareSandboxRuntime();
  await using _runtimeCleanup = cleanupSandboxRuntimeAfterSession(
    service,
    runtimePackage.id,
  );
  const plannedSpec = await buildSandboxInstanceSpec(
    {
      runtime: service.runtime,
      hostAccessName: hostInfo.hostAccessName,
      storage: service.storage,
    },
    {
      runtimePackage,
      config,
      projectRoot,
      currentDir,
      projectSlug,
      repositoryRoots,
    },
  );

  const containerSpec: SandboxInstanceSpec = {
    ...plannedSpec,
    image: buildResult.image,
  };

  if (foreground) {
    if (executorOptions.timingLabel && verbose) {
      logger.endTiming(executorOptions.timingLabel);
    }
    await runForegroundContainer(service, { containerSpec, projectSlug });
    return;
  }

  const resolved = await resolveExecutionContainer(service, {
    containerSpec,
    imageIdentity: buildResult.image.digest,
    projectSlug,
    skipReuse,
  });
  if (resolved.created) {
    logger.info("Creating sandbox container...");
    const logCapture = captureStartupLogs(service, resolved.containerName);
    await waitForReady(service, resolved.containerName).catch(async (error) => {
      await logCapture.stop();
      logCapture.reportFailure();
      throw error;
    });
    await logCapture.stop();
    logger.debug(`Container ${resolved.containerName} is ready`);
  }
  logger.endTiming("Container setup");

  await using hostCommandEscapeSession = await startHostCommandEscapeSession({
    commandRules: config.allowHostCommands,
    hostProjectRoot: projectRoot,
    containerProjectRoot: windowsPathToDocker(projectRoot),
    containerHostName: hostInfo.hostAccessName,
  });
  const brokerEndpoint =
    hostCommandEscapeSession.clientEnvironment[
      HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE
    ];
  if (!brokerEndpoint) {
    throw new Error("The host-command broker did not provide an endpoint.");
  }
  await using _hostCommandNetworkAccess = config.noProxy
    ? undefined
    : await allowHostCommandNetworkAccess(
        service.instances,
        resolved.containerName,
        brokerEndpoint,
      );
  if (executorOptions.timingLabel && verbose) {
    logger.endTiming(executorOptions.timingLabel);
  }
  const execution = buildSandboxExecSpec({
    currentDir,
    command,
    stdin,
    tty,
    environment: config.env,
    proxyEnabled: !config.noProxy,
    hostCommandEscapeEnvironment: hostCommandEscapeSession.clientEnvironment,
    verbose,
  });

  const title = resolveHostAgentTitle(command);
  if (title) logger.debug(`Host agent title: ${chalk.cyan(title)}`);
  const result = await service.instances.execAttached(
    resolved.containerName,
    execution.spec,
    {
      ...execution.session,
      ...(title ? { title } : {}),
      forwardSignal: (signal) => hostCommandEscapeSession.forwardSignal(signal),
    },
  );
  throwForChildExit(result.exitCode);
}

export async function executeInSandbox(
  cliOptions: SandboxOptions,
  executorOptions: ExecutorOptions,
): Promise<void> {
  const logger = getLogger();
  const environment = getHostEnvironment();
  const { timingLabel, beforeSpawn } = executorOptions;
  const useVerboseTiming = cliOptions.verbose === true;
  const silent = cliOptions.silent === true;

  if (timingLabel && useVerboseTiming) logger.startTiming(timingLabel);
  if (useVerboseTiming) logger.startTiming("Load config");
  const { config, projectRoot, repositoryRoots, runtimeResolution } =
    await getConfigurationService().load(cliOptions);
  validateConfiguredEnvironment(config.env);
  if (executorOptions.foreground && config.env.length > 0) {
    logger.warn(
      `${chalk.cyan("sandbox container start")} does not start a session and does not apply env`,
    );
  }
  const runtimeSelection =
    await getRuntimeProvider().resolve(runtimeResolution);
  const { runtime } = runtimeSelection;
  config.runtime = runtime.runtime;
  if (useVerboseTiming) logger.endTiming("Load config");
  const ctx: SandboxContext = { config, projectRoot, repositoryRoots };
  const buildResult = await prepareSandboxEnvironment(
    runtimeSelection,
    ctx,
    cliOptions,
    useVerboseTiming,
    silent,
  );

  if (
    normalizePath(normalize(projectRoot)) ===
    normalizePath(normalize(environment.homeDirectory))
  ) {
    if (!silent) {
      const terminal = getTerminal();
      terminal.stderr.write(
        `${chalk.yellow("⚠️  Project root is your home directory!")}\n`,
      );
      terminal.stderr.write(`${chalk.yellow(`   ${projectRoot}`)}\n`);
      terminal.stderr.write(
        `${chalk.yellow("   This will expose your entire home folder inside the sandbox.\n")}\n`,
      );
    }
    const confirmed = await confirmDestruction(
      "Continue with home directory as workspace?",
    );
    if (!confirmed) {
      if (!silent) {
        writeOutput("Aborted. Run sandbox from a project directory instead.");
      }
      throw new SandboxExecutionExitError(1);
    }
  }

  beforeSpawn?.(config);
  if (!executorOptions.foreground) {
    await warnIfX11Unavailable(silent, config.clipboard);
  }
  await execute(
    runtime,
    ctx,
    executorOptions,
    useVerboseTiming,
    cliOptions.containerReuse === false,
    buildResult,
  );
}
