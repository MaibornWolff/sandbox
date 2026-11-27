import { randomUUID } from "node:crypto";
import { normalize } from "node:path";
import chalk from "chalk";
import { getClipboardCapabilityFactory } from "#modules/clipboard/index.js";
import {
  type Config,
  getConfigurationService,
} from "#modules/configuration/index.js";
import { getHostBridgeService } from "#modules/host-bridge/index.js";
import { createHostCommandCapability } from "#modules/host-command-escape/index.js";
import type { BuildImagesResult } from "#modules/sandbox-images/index.js";
import {
  cleanupSandboxRuntimeAfterSession,
  prepareSandboxRuntime,
} from "#modules/sandbox-runtime/index.js";
import { getClock, waitWithTimeout } from "#platform/clock/index.js";
import type {
  SandboxAttachmentLaunch,
  SandboxInstanceOperations,
  SandboxInstanceSpec,
  SandboxRuntime,
  TerminalSessionOptions,
} from "#platform/container-runtime/index.js";
import { getRuntimeProvider } from "#platform/container-runtime/index.js";
import {
  buildSessionLaunchCommand,
  buildSessionStopCommand,
} from "#platform/container-system/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { readPackageVersion } from "#platform/filesystem/index.js";
import type { ForegroundJobPublication } from "#platform/foreground-job/index.js";
import { getLogger } from "#platform/logging/index.js";
import {
  getExitCodeForSignal,
  getProcessManager,
} from "#platform/process/index.js";
import { confirmDestruction, getTerminal } from "#platform/terminal/index.js";
import { getErrorMessage } from "#shared/errors/index.js";
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
import { prepareClipboardSession } from "./clipboard-session.js";
import {
  createFreshContainer,
  findOrCreateContainer,
  pickFreshContainerName,
} from "./container-reuse.js";
import {
  ContainerReadinessError,
  prepareContainerSession,
} from "./container-session.js";
import { readControlLines } from "./control-watchdog.js";
import {
  observeForegroundAttachment,
  prepareForegroundLaunch,
  publishForegroundJob,
  verifyForegroundTarget,
  verifyPublicationMounts,
} from "./foreground-job-launch.js";
import { resolveHostAgentTitle } from "./host-agent-title.js";
import { prepareSandboxEnvironment } from "./sandbox-preparation.js";
import { runSessionHooks } from "./session-hooks.js";
import { captureStartupLogs } from "./startup-logs.js";

interface ExecutorOptions {
  readonly command: string[];
  readonly stdin: boolean;
  readonly tty: boolean;
  readonly timingLabel?: string;
  readonly beforeSpawn?: (config: Config) => void;
  readonly foreground?: boolean;
  readonly wrapper?: boolean;
}

class SandboxExecutionExitError extends Error {
  readonly reported = true;

  constructor(
    readonly exitCode: number,
    readonly signal?: NodeJS.Signals,
  ) {
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

async function prepareResolvedSession(
  service: SandboxRuntime,
  options: {
    readonly containerId: string;
    readonly containerName: string;
    readonly created: boolean;
    readonly endpoint?: string;
    readonly signal: AbortSignal;
  },
): Promise<{
  readonly containerId: string;
  readonly containerName: string;
  readonly access: AsyncDisposable;
}> {
  const logger = getLogger();
  if (options.created) logger.info("Creating sandbox container...");
  await using resources = new AsyncDisposableStack();
  const logCapture = options.created
    ? resources.use(captureStartupLogs(service, options.containerId))
    : undefined;
  const access = await prepareContainerSession({
    containers: service.instances,
    containerId: options.containerId,
    endpoint: options.endpoint,
    timeoutMs: options.created ? 30_000 : 5_000,
    signal: options.signal,
  }).catch(async (error) => {
    if (logCapture && !options.signal.aborted) {
      await logCapture.stop();
      logCapture.reportFailure();
    }
    throw error;
  });
  resources.use(access);
  await logCapture?.stop();
  logger.debug(`Container ${chalk.cyan(options.containerName)} is ready`);
  return {
    containerId: options.containerId,
    containerName: options.containerName,
    access: resources.move(),
  };
}

async function resolveExecutionContainer(
  service: SandboxRuntime,
  options: {
    readonly containerSpec: SandboxInstanceSpec;
    readonly imageIdentity: string;
    readonly projectSlug: string;
    readonly skipReuse: boolean;
    readonly endpoint?: string;
    readonly signal: AbortSignal;
  },
): ReturnType<typeof prepareResolvedSession> {
  const logger = getLogger();
  if (options.skipReuse) {
    return prepareResolvedSession(service, {
      ...(await createFreshContainer(
        service,
        options.projectSlug,
        options.containerSpec,
      )),
      endpoint: options.endpoint,
      signal: options.signal,
    });
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

  try {
    return await prepareResolvedSession(service, {
      ...result,
      endpoint: options.endpoint,
      signal: options.signal,
    });
  } catch (error) {
    if (result.created || !(error instanceof ContainerReadinessError))
      throw error;
    const instance = await service.instances.inspect(result.containerId);
    if (
      instance &&
      instance.state !== "stopping" &&
      instance.state !== "exited" &&
      instance.state !== "dead"
    )
      throw error;
    logger.debug(
      `Reused container ${chalk.cyan(result.containerName)} stopped, creating new one`,
    );
    result = await findOrCreateContainer(
      service,
      options.projectSlug,
      hash,
      options.containerSpec,
    );
    return prepareResolvedSession(service, {
      ...result,
      endpoint: options.endpoint,
      signal: options.signal,
    });
  }
}

function warnForWrapperConflict(enabled: boolean, conflict: boolean): void {
  if (enabled && conflict) {
    getLogger().warn(
      "The trusted project session wrapper overrides the user wrapper. To use the user wrapper, invoke it manually with sandbox run --no-wrapper -- <user-wrapper> <command>.",
    );
  }
}

async function stopGuestSession(
  containers: SandboxInstanceOperations,
  containerName: string,
  runtimeDirectory: string,
  sessionId: string,
): Promise<void> {
  const logger = getLogger();
  logger.debug(`Stopping guest session ${chalk.cyan(sessionId)}.`);
  try {
    await using cleanup = await containers.openExec(containerName, {
      user: "root",
      command: buildSessionStopCommand(runtimeDirectory, sessionId),
    });
    let diagnostic = "";
    const result = await waitWithTimeout(
      Promise.all([
        cleanup.completion,
        readControlLines(cleanup.stdout, () => undefined),
        readControlLines(cleanup.stderr, (line) => {
          diagnostic ||= line;
        }),
      ]),
      { clock: getClock(), milliseconds: 3_000 },
    );
    if (!result.completed) throw new Error("Cleanup exec timed out.");
    const [{ exitCode }] = result.value;
    if (exitCode !== 0) {
      throw new Error(
        diagnostic || `Cleanup exec exited with code ${exitCode}.`,
      );
    }
  } catch (error) {
    logger.warn(
      `Could not stop guest session ${sessionId}: ${getErrorMessage(error)}`,
    );
  }
}

async function runAttachedSession(
  hookSession: Omit<Parameters<typeof runSessionHooks>[0], "event" | "signal">,
  options: {
    readonly session: TerminalSessionOptions;
    readonly signal: AbortSignal;
    readonly runtimeDirectory: string;
    readonly sessionId: string;
    readonly attachmentEnded: () => void;
  },
) {
  const { containers, containerId, spec } = hookSession;
  const { session, signal, runtimeDirectory, sessionId } = options;
  await runSessionHooks({ ...hookSession, event: "session.start", signal });
  signal.throwIfAborted();
  let guestStop: Promise<void> | undefined;
  const stopGuest = () =>
    (guestStop ??= stopGuestSession(
      containers,
      containerId,
      runtimeDirectory,
      sessionId,
    ));
  const getTermination = () => {
    const reason: unknown = signal.reason;
    return reason instanceof SandboxExecutionExitError &&
      (reason.signal === "SIGHUP" || reason.signal === "SIGTERM")
      ? reason
      : undefined;
  };
  const onTermination = () => {
    if (getTermination()) {
      options.attachmentEnded();
      void stopGuest();
    }
  };
  signal.addEventListener("abort", onTermination, { once: true });
  let attachmentLost = true;
  try {
    const result = await containers.execAttached(containerId, spec, session);
    attachmentLost = result.signal !== undefined;
    const termination = getTermination();
    if (termination) throw termination;
    return result;
  } finally {
    options.attachmentEnded();
    signal.removeEventListener("abort", onTermination);
    if (attachmentLost || signal.aborted) await stopGuest();
    await runSessionHooks({ ...hookSession, event: "session.end" }).catch(
      (error: unknown) =>
        getLogger().warn(`Session end hook failed: ${getErrorMessage(error)}`),
    );
  }
}

async function execute(
  service: SandboxRuntime,
  ctx: SandboxContext,
  executorOptions: ExecutorOptions,
  verbose: boolean,
  skipReuse: boolean,
  buildResult: BuildImagesResult,
  job: {
    readonly sessionId: string;
    readonly publication?: ForegroundJobPublication;
    readonly context?: SandboxAttachmentLaunch;
  },
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

  const { sessionId, publication, context } = job;
  verifyPublicationMounts(publication, containerSpec.mounts);
  await using commandCapability = await createHostCommandCapability({
    sessionId,
    runtime: service.runtime,
    commandRules: config.allowHostCommands,
    hostProjectRoot: projectRoot,
    containerProjectRoot: windowsPathToDocker(projectRoot),
  });
  await using clipboardCapabilities =
    config.clipboard === "enabled"
      ? getClipboardCapabilityFactory().create()
      : undefined;
  await using bridgeSession = await getHostBridgeService().startSession({
    containerHostName: hostInfo.hostAccessName,
    capabilities: [
      commandCapability,
      ...(clipboardCapabilities?.capabilities ?? []),
    ],
  });
  await using sessionResources = new AsyncDisposableStack();
  const beforeCommand = new AbortController();
  void getProcessManager().termination.then((signal) =>
    beforeCommand.abort(
      new SandboxExecutionExitError(getExitCodeForSignal(signal), signal),
    ),
  );
  const { containerId, containerName } = await service.withInstanceStartup(
    async () => {
      const resolved = await resolveExecutionContainer(service, {
        containerSpec,
        imageIdentity: buildResult.image.digest,
        projectSlug,
        skipReuse,
        endpoint: config.noProxy ? undefined : bridgeSession.endpoint,
        signal: beforeCommand.signal,
      });
      sessionResources.use(resolved.access);
      return resolved;
    },
  );
  const foregroundTarget = await verifyForegroundTarget(
    publication,
    context,
    service,
    containerId,
  );
  const unpublish = () => publication?.[Symbol.dispose]();
  commandCapability.setContainerName(containerName);
  const sessionEnvironment = {
    ...bridgeSession.clientEnvironment,
    SANDBOX_SESSION_ID: sessionId,
  };
  if (clipboardCapabilities) {
    const clipboard = sessionResources.use(
      await prepareClipboardSession({
        containers: service.instances,
        containerId,
        bridgeEnvironment: bridgeSession.clientEnvironment,
      }),
    );
    Object.assign(sessionEnvironment, clipboard.environment);
  } else {
    logger.debug("Clipboard access is disabled by configuration.");
  }
  logger.endTiming("Container setup");
  if (executorOptions.timingLabel && verbose) {
    logger.endTiming(executorOptions.timingLabel);
  }
  warnForWrapperConflict(
    executorOptions.wrapper !== false,
    config.session.wrapperConflict,
  );
  const runtimeDirectory = runtimePackage.mount.containerPath;
  const execution = buildSandboxExecSpec({
    currentDir,
    command: buildSessionLaunchCommand(runtimeDirectory, sessionId, [
      ...(executorOptions.wrapper === false
        ? []
        : config.session.commandWrapper),
      ...command,
    ]),
    stdin,
    tty,
    environment: config.env,
    proxyEnabled: !config.noProxy,
    sessionEnvironment,
    verbose,
  });

  const hookSession = {
    containers: service.instances,
    containerId,
    spec: execution.spec,
    hooks: config.hooks,
  };
  const title = resolveHostAgentTitle(command);
  if (title) logger.debug(`Host agent title: ${chalk.cyan(title)}`);
  try {
    const result = await runAttachedSession(hookSession, {
      session: {
        ...execution.session,
        ...(title ? { title } : {}),
        forwardSignal: (signal) => commandCapability.forwardSignal(signal),
        ...observeForegroundAttachment(publication, foregroundTarget),
      },
      signal: beforeCommand.signal,
      runtimeDirectory,
      sessionId,
      attachmentEnded: unpublish,
    });
    throwForChildExit(result.exitCode);
  } finally {
    publication?.[Symbol.dispose]();
    await sessionResources
      .disposeAsync()
      .catch((error: unknown) =>
        logger.warn(`Session cleanup failed: ${getErrorMessage(error)}`),
      );
  }
}

async function confirmHomeWorkspace(
  projectRoot: string,
  silent: boolean,
): Promise<void> {
  const environment = getHostEnvironment();
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
}

export async function executeInSandbox(
  cliOptions: SandboxOptions,
  executorOptions: ExecutorOptions,
): Promise<void> {
  const logger = getLogger();
  const { timingLabel, beforeSpawn } = executorOptions;
  const useVerboseTiming = cliOptions.verbose === true;
  const silent = cliOptions.silent === true;
  const sessionId = randomUUID();
  await using context = await prepareForegroundLaunch(
    executorOptions.tty && !executorOptions.foreground,
  );
  using publication = context
    ? await publishForegroundJob(sessionId, context.hostMounts)
    : undefined;

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
  const selected = await getRuntimeProvider().resolve(runtimeResolution);
  const pinned =
    selected.runtime.runtime === "podman" && publication ? context : undefined;
  if (!pinned) publication?.markUnavailable();
  const runtimeSelection = pinned?.selection ?? selected;
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

  await confirmHomeWorkspace(projectRoot, silent);

  beforeSpawn?.(config);
  await execute(
    runtime,
    ctx,
    executorOptions,
    useVerboseTiming,
    cliOptions.containerReuse === false,
    buildResult,
    { sessionId, publication, context: pinned },
  );
}
