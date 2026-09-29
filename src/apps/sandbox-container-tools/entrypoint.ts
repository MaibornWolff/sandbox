import {
  type ContainerNetworkLifecycle,
  parseNetworkBootstrapRequest,
  startContainerNetwork,
} from "#modules/network/index.js";
import { type Clock, getClock } from "#platform/clock/index.js";
import {
  getTcpService,
  inspectSessionActivity,
  markContainerReady,
  parseIdeBridgePort,
  prepareContainerState,
  repairMountOwnership,
  runSettingsApplyAsSandbox,
  runSettingsSyncAsSandbox,
  startIdeBridge,
  terminateContainerSessions,
  writeSshProxyConfiguration,
} from "#platform/container-system/index.js";
import {
  getSandboxEnvironment,
  type SandboxEnvironment,
} from "#platform/environment/index.js";
import { getLogger } from "#platform/logging/index.js";
import {
  getExitCodeForSignal,
  getProcessManager,
  type ProcessManager,
} from "#platform/process/index.js";

import { getErrorMessage } from "#shared/errors/index.js";

function idleTimeoutMilliseconds(value: string | undefined): number {
  if (value === undefined) return 5_000;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Invalid SANDBOX_IDLE_TIMEOUT_SECONDS: ${value}`);
  }
  return seconds * 1_000;
}

export async function runContainerEntrypoint(
  _defaultCommand: readonly string[] = [],
): Promise<number> {
  const environment = getSandboxEnvironment();
  const clock = getClock();
  const logger = getLogger();
  const processes = getProcessManager();
  getTcpService();
  let receivedSignal: NodeJS.Signals | undefined;
  const networkCancellation = new AbortController();
  const signalReceived = processes.termination;
  void signalReceived.then((signal) => {
    receivedSignal = signal;
    networkCancellation.abort(
      new DOMException("Network startup was cancelled", "AbortError"),
    );
  });

  try {
    logger.debug("entrypoint starting");
    prepareContainerState();
    logger.debug("container state prepared");
    repairMountOwnership();
    logger.debug("mount ownership repaired");
    await runSettingsApplyAsSandbox();
    logger.debug("copied settings applied");

    const idePort = parseIdeBridgePort(
      environment.variables.CLAUDE_CODE_SSE_PORT,
    );
    const ideLifecycle =
      idePort === undefined ? undefined : startIdeBridge(idePort);

    const serializedNetwork = environment.variables.SANDBOX_FIREWALL;
    const networkStartup = serializedNetwork
      ? initializeManagedNetwork(
          serializedNetwork,
          networkCancellation.signal,
          () => receivedSignal !== undefined,
        ).then((lifecycle) => {
          logger.debug("managed network started");
          return lifecycle;
        })
      : Promise.resolve({
          failure: new Promise<Error>(() => undefined),
        });
    const startupResult = await Promise.race([
      networkStartup.then((lifecycle) => ({
        type: "started" as const,
        lifecycle,
      })),
      ...(ideLifecycle
        ? [
            ideLifecycle.failure.then((failure) => ({
              type: "failure" as const,
              failure,
            })),
          ]
        : []),
      signalReceived.then((signal) => ({ type: "signal" as const, signal })),
    ]);
    if (startupResult.type === "failure") {
      networkCancellation.abort(
        new DOMException(
          "Network startup was cancelled after a required child failure",
          "AbortError",
        ),
      );
      await settleNetworkStartup(
        networkStartup,
        "network startup stopped after child exit",
      );
      throw startupResult.failure;
    }
    if (startupResult.type === "signal") {
      await settleNetworkStartup(
        networkStartup,
        "network startup stopped after signal",
      );
      return getExitCodeForSignal(startupResult.signal);
    }

    logger.debug("ready");
    markContainerReady();
    const ownerFailure = ideLifecycle
      ? Promise.race([ideLifecycle.failure, startupResult.lifecycle.failure])
      : startupResult.lifecycle.failure;
    await waitForShutdown(
      environment,
      clock,
      ownerFailure,
      signalReceived,
      () => receivedSignal !== undefined,
    );
  } finally {
    try {
      await shutdownManagedChildren(processes, receivedSignal);
    } finally {
      try {
        await terminateContainerSessions(receivedSignal ?? "SIGTERM");
      } finally {
        logger.debug("syncing settings");
        try {
          await runSettingsSyncAsSandbox();
        } catch (error) {
          logger.debug(
            `settings sync failed (non-fatal): ${getErrorMessage(error)}`,
          );
        }
      }
    }
  }
  return receivedSignal ? getExitCodeForSignal(receivedSignal) : 0;
}

async function shutdownManagedChildren(
  processes: ProcessManager,
  receivedSignal: NodeJS.Signals | undefined,
): Promise<void> {
  try {
    await processes.stopAll({ signal: receivedSignal ?? "SIGTERM" });
  } catch (error) {
    if (receivedSignal === undefined) throw error;
    const message = getErrorMessage(error);
    getLogger().error(message);
  }
}

async function settleNetworkStartup(
  startup: Promise<unknown>,
  failureContext: string,
): Promise<void> {
  try {
    await startup;
  } catch (error) {
    getLogger().debug(`${failureContext}: ${getErrorMessage(error)}`);
  }
}

async function initializeManagedNetwork(
  serializedNetwork: string,
  signal: AbortSignal,
  signalWasReceived: () => boolean,
): Promise<ContainerNetworkLifecycle> {
  const request = parseNetworkBootstrapRequest(serializedNetwork);
  const lifecycle = await startContainerNetwork(request, { signal });
  if (!request.noProxy && !signalWasReceived()) writeSshProxyConfiguration();
  return lifecycle;
}

interface IdleState {
  hadSessions: boolean;
  lastActivityAt: number;
}

function updateIdleState(
  state: IdleState,
  activity: ReturnType<typeof inspectSessionActivity>,
  now: number,
): void {
  if (activity.active || activity.markerSeen) {
    state.hadSessions = true;
    state.lastActivityAt = now;
  }
}

function shouldShutdownForIdle(options: {
  readonly state: IdleState;
  readonly timeout: number;
  readonly now: number;
}): boolean {
  if (
    !options.state.hadSessions ||
    options.now - options.state.lastActivityAt < options.timeout
  ) {
    return false;
  }
  const finalActivity = inspectSessionActivity();
  if (!finalActivity.active && !finalActivity.markerSeen) return true;
  options.state.lastActivityAt = options.now;
  return false;
}

async function waitForShutdownEvent(
  clock: Clock,
  ownerFailure: Promise<Error>,
  signalReceived: Promise<NodeJS.Signals>,
): Promise<"signal" | "tick"> {
  const tickCancellation = new AbortController();
  try {
    const event = await Promise.race([
      ownerFailure.then((failure) => ({ type: "failure" as const, failure })),
      signalReceived.then(() => ({ type: "signal" as const })),
      clock
        .sleep(1_000, { signal: tickCancellation.signal })
        .then(() => ({ type: "tick" as const }))
        .catch((error: unknown) => {
          if (tickCancellation.signal.aborted) {
            return { type: "cancelled" as const };
          }
          throw error;
        }),
    ]);
    if (event.type === "failure") throw event.failure;
    return event.type === "tick" ? "tick" : "signal";
  } finally {
    tickCancellation.abort();
  }
}

async function waitForShutdown(
  environment: SandboxEnvironment,
  clock: Clock,
  ownerFailure: Promise<Error>,
  signalReceived: Promise<NodeJS.Signals>,
  signalWasReceived: () => boolean,
): Promise<void> {
  const timeout = idleTimeoutMilliseconds(
    environment.variables.SANDBOX_IDLE_TIMEOUT_SECONDS,
  );
  const state: IdleState = {
    hadSessions: false,
    lastActivityAt: clock.now(),
  };

  while (true) {
    const now = clock.now();
    const activity = inspectSessionActivity();
    updateIdleState(state, activity, now);
    if (shouldShutdownForIdle({ state, timeout, now })) return;
    const event = await waitForShutdownEvent(
      clock,
      ownerFailure,
      signalReceived,
    );
    if (event === "signal" || signalWasReceived()) return;
  }
}
