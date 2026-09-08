import { normalize } from "node:path";
import chalk from "chalk";
import {
  type Config,
  getConfigurationService,
} from "#modules/configuration/index.js";
import { startHostCommandEscapeSession } from "#modules/host-command-escape/index.js";
import type { BuildImagesResult } from "#modules/sandbox-images/index.js";
import {
  type ContainerRuntime,
  getRuntimeProvider,
  runInteractiveContainerRuntimeProcess,
  startContainerLogStream,
} from "#platform/container-runtime/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { readPackageVersion } from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import { confirmDestruction, getTerminal } from "#platform/terminal/index.js";
import {
  generateProjectSlug,
  normalizePath,
  redactCommandForDisplay,
  windowsPathToDocker,
} from "#shared/text/index.js";
import { buildContainerArgs } from "../arguments/container-arguments.js";
import { buildExecArgs } from "../arguments/session-arguments.js";
import { computeContainerHash } from "../container-hashing.js";
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
  getImageIdFallback,
  prepareSandboxEnvironment,
  warnIfX11Unavailable,
} from "./sandbox-preparation.js";

interface ExecutorOptions {
  command: string[];
  stdin: boolean;
  tty: boolean;
  timingLabel?: string;
  beforeSpawn?: (config: Config) => void;
  /** Run the container in the foreground (non-detached, no --rm). */
  foreground?: boolean;
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
  service: ContainerRuntime,
  options: {
    readonly containerArgs: string[];
    readonly projectSlug: string;
  },
): Promise<void> {
  const logger = getLogger();
  const containerName = await pickFreshContainerName(
    service,
    options.projectSlug,
  );
  const runArgs = [
    "run",
    "--init",
    "--name",
    containerName,
    ...options.containerArgs,
  ];
  logger.debug(
    `Foreground run: ${redactCommandForDisplay(service.binaryName, runArgs)}`,
  );
  logger.endTiming("Container setup");

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

  const result = await runInteractiveContainerRuntimeProcess(service, {
    args: runArgs,
    signalContainer: containerName,
  });
  if (result.exitCode !== 0) {
    writeOutput();
    writeOutput(chalk.yellow("Container stopped. Inspect with:"));
    writeOutput(chalk.dim(`  ${service.binaryName} logs ${containerName}`));
    writeOutput(chalk.dim(`  ${service.binaryName} inspect ${containerName}`));
    writeOutput(
      chalk.dim(`  ${service.binaryName} rm ${containerName}  # to clean up`),
    );
  }
  throwForChildExit(result.exitCode);
}

async function resolveExecutionContainer(
  service: ContainerRuntime,
  options: {
    readonly containerArgs: string[];
    readonly imageName: string;
    readonly imageId: string;
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
        options.containerArgs,
        options.imageName,
      ),
      created: true,
    };
  }

  const imageId =
    options.imageId || (await getImageIdFallback(service, options.imageName));
  if (!imageId) {
    logger.error(
      `Failed to get image ID for ${options.imageName}. Run 'sandbox build' first.`,
    );
    throw new SandboxExecutionExitError(1);
  }

  const version = readPackageVersion();
  const hash = computeContainerHash(version, imageId, options.containerArgs);
  logger.debug(
    `Container hash: ${hash} (version=${version}, image=${options.imageName})`,
  );
  let result = await findOrCreateContainer(
    service,
    options.projectSlug,
    hash,
    options.containerArgs,
    options.imageName,
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
        options.containerArgs,
        options.imageName,
      );
      return { ...result, created: true };
    }
  }
  return result;
}

async function execute(
  service: ContainerRuntime,
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

  logger.startTiming("Container setup");
  const { args: containerArgs, imageName } = await buildContainerArgs(service, {
    config,
    projectRoot,
    currentDir,
    projectSlug,
    repositoryRoots,
  });

  if (foreground) {
    if (executorOptions.timingLabel && verbose) {
      logger.endTiming(executorOptions.timingLabel);
    }
    await runForegroundContainer(service, { containerArgs, projectSlug });
    return;
  }

  const resolved = await resolveExecutionContainer(service, {
    containerArgs,
    imageName,
    imageId: buildResult.imageName === imageName ? buildResult.imageId : "",
    projectSlug,
    skipReuse,
  });
  if (resolved.created) {
    logger.info("Creating sandbox container...");
    const logStream = startContainerLogStream(service, resolved.containerName);
    await waitForReady(service, resolved.containerName).catch(async (error) => {
      await logStream.stop();
      logStream.reportFailure();
      throw error;
    });
    await logStream.stop();
    logger.debug(`Container ${resolved.containerName} is ready`);
  }
  logger.endTiming("Container setup");

  await using hostCommandEscapeSession = await startHostCommandEscapeSession({
    commandRules: config.allowHostCommands,
    hostProjectRoot: projectRoot,
    containerProjectRoot: windowsPathToDocker(projectRoot),
    containerHostName: service.getHostInternalDns(),
  });
  if (executorOptions.timingLabel && verbose) {
    logger.endTiming(executorOptions.timingLabel);
  }
  const execArgs = buildExecArgs({
    containerName: resolved.containerName,
    currentDir,
    command,
    stdin,
    tty,
    proxyEnabled: !config.noProxy,
    hostCommandEscapeEnvironment: hostCommandEscapeSession.clientEnvironment,
    verbose,
  });
  logger.debug(
    `Exec command: ${redactCommandForDisplay(service.binaryName, ["exec", ...execArgs])}`,
  );

  const title = resolveHostAgentTitle(command);
  if (title) logger.debug(`Host agent title: ${chalk.cyan(title)}`);
  const result = await runInteractiveContainerRuntimeProcess(service, {
    args: ["exec", ...execArgs],
    ...(title ? { title } : {}),
    forwardSignal: (signal) => hostCommandEscapeSession.forwardSignal(signal),
  });
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
  const { config, projectRoot, repositoryRoots, configuredRuntime } =
    await getConfigurationService().load(cliOptions);
  const runtimeService = await getRuntimeProvider().resolve(configuredRuntime);
  config.runtime = runtimeService.runtime;
  if (useVerboseTiming) logger.endTiming("Load config");
  const ctx: SandboxContext = { config, projectRoot, repositoryRoots };
  const buildResult = await prepareSandboxEnvironment(
    runtimeService,
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
    runtimeService,
    ctx,
    executorOptions,
    useVerboseTiming,
    cliOptions.containerReuse === false,
    buildResult,
  );
}
