import chalk from "chalk";
import { type Clock, waitWithTimeout } from "#platform/clock/index.js";
import {
  formatErrorDiagnostics,
  getLogger,
  type Logger,
} from "#platform/logging/index.js";
import { getErrorMessage } from "#shared/errors/index.js";
import type {
  ProcessAdapter,
  ProcessIdentity,
  ProcessIdentityStatus,
  StartedProcess,
} from "./process-adapter.js";
import {
  type CapturedProcessResult,
  type CaptureProcessRequest,
  type ManagedProcess,
  type ManagedStreamingProcess,
  ProcessCleanupError,
  type ProcessExit,
  ProcessIdentityError,
  type ProcessManager,
  type ProcessResult,
  ProcessShutdownError,
  SignalForwardingError,
  type StandardProcessRequest,
  type StartProcessRequest,
  type StopOptions,
  type StreamingProcessRequest,
  type StreamingProcessResult,
} from "./process-manager.js";

type ProcessClock = Pick<Clock, "sleep">;

const DEFAULT_STOP_TIMEOUT_MILLISECONDS = 5_000;
const IDENTITY_POLL_MILLISECONDS = 50;

interface ProcessLogger {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const silentLogger: ProcessLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function validateRequestDiscriminants(request: StartProcessRequest): void {
  if (!request || typeof request !== "object") {
    throw new TypeError("Process start request must be an object.");
  }
  const shaped = request as {
    readonly lifetime?: unknown;
    readonly interaction?: { readonly mode?: unknown };
  };
  if (shaped.lifetime !== "application" && shaped.lifetime !== "detached") {
    throw new TypeError(
      'Process lifetime must be "application" or "detached".',
    );
  }
  if (
    shaped.interaction?.mode !== "non-interactive" &&
    shaped.interaction?.mode !== "interactive"
  ) {
    throw new TypeError(
      'Process interaction mode must be "non-interactive" or "interactive".',
    );
  }
  if (
    shaped.lifetime === "detached" &&
    shaped.interaction.mode === "interactive"
  ) {
    throw new TypeError("Detached processes cannot be interactive.");
  }
}

function validateInteractiveRequest(request: StartProcessRequest): void {
  if (request.interaction.mode !== "interactive") return;
  if (request.stdio !== undefined && request.stdio !== "inherit") {
    throw new TypeError("Interactive processes must inherit terminal streams.");
  }
  if (request.stdin === "ignore") {
    throw new TypeError("Interactive processes cannot ignore terminal input.");
  }
  if (request.onStdout || request.onStderr || request.stdoutFile) {
    throw new TypeError(
      "Interactive processes cannot configure output callbacks or files.",
    );
  }
}

function validateDetachedRequest(request: StartProcessRequest): void {
  if (request.lifetime !== "detached") return;
  if (request.stdio !== undefined && request.stdio !== "ignore") {
    throw new TypeError("Detached processes must ignore terminal streams.");
  }
  if (request.stdin !== undefined && request.stdin !== "ignore") {
    throw new TypeError("Detached processes must ignore terminal input.");
  }
  if (request.onStdout || request.onStderr) {
    throw new TypeError(
      "Detached processes cannot configure output callbacks.",
    );
  }
}

function validateStreamingRequest(request: StartProcessRequest): void {
  if (request.stdio !== "stream") return;
  if (
    request.lifetime !== "application" ||
    request.interaction.mode !== "non-interactive"
  ) {
    throw new TypeError(
      "Streaming processes must be non-interactive application processes.",
    );
  }
  if (
    request.stdin !== undefined ||
    request.onStdout !== undefined ||
    request.onStderr !== undefined ||
    request.stdoutFile !== undefined
  ) {
    throw new TypeError(
      "Streaming processes expose dedicated input and output streams.",
    );
  }
}

function validateStartRequest(request: StartProcessRequest): void {
  validateRequestDiscriminants(request);
  validateInteractiveRequest(request);
  validateDetachedRequest(request);
  validateStreamingRequest(request);
}

function isMissingSignalError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  );
}

class ManagedProcessHandle<TResult> implements ManagedProcess<TResult> {
  readonly result: Promise<TResult>;
  readonly exited: Promise<ProcessExit>;
  private resolveExited: (exit: ProcessExit) => void = () => undefined;
  private rejectExited: (error: unknown) => void = () => undefined;
  private stopPromise: Promise<ProcessExit> | undefined;
  private disposed = false;
  private exit: ProcessExit | undefined;
  private sourceExit: ProcessExit | undefined;
  private readonly monitoring = new AbortController();

  constructor(
    readonly name: string,
    result: Promise<TResult>,
    private readonly identity: ProcessIdentity | undefined,
    private readonly adapter: ProcessAdapter,
    private readonly clock: ProcessClock,
    private readonly logger: ProcessLogger,
    private readonly raw: StartedProcess<TResult> | undefined,
    private readonly onExit: (error?: unknown) => void,
    monitor: "started" | "captured" | "detached",
  ) {
    this.result = result;
    void result.then(
      (value) => {
        if (
          typeof value === "object" &&
          value !== null &&
          "exitCode" in value &&
          typeof value.exitCode === "number"
        ) {
          const source = value as {
            readonly exitCode: number;
            readonly signal?: NodeJS.Signals;
          };
          this.sourceExit = {
            exitCode: source.exitCode,
            ...(source.signal ? { signal: source.signal } : {}),
          };
        }
      },
      () => undefined,
    );
    this.exited = new Promise<ProcessExit>((resolve, reject) => {
      this.resolveExited = resolve;
      this.rejectExited = reject;
    });
    void this.result.catch(() => undefined);
    void this.exited.catch(() => undefined);
    this.monitor = monitor;
  }

  private readonly monitor: "started" | "captured" | "detached";

  beginMonitoring(): void {
    if (this.monitor === "started") void this.monitorStarted();
    if (this.monitor === "captured") void this.monitorCaptured();
    if (this.monitor === "detached") {
      void this.raw?.exited.then(() => this.finish({}));
    }
  }

  signalForeground(signal: NodeJS.Signals): void {
    this.signalVerified(signal);
  }

  unrefSurvivor(): void {
    if (this.identity) this.adapter.unref(this.identity);
  }

  private finish(exit: ProcessExit): void {
    if (this.exit) return;
    this.exit = exit;
    this.monitoring.abort();
    this.logger.debug(
      `Managed process ${chalk.cyan(this.name)} exited${exit.signal ? ` with signal ${exit.signal}` : exit.exitCode === undefined ? "" : ` with code ${exit.exitCode}`}`,
    );
    this.resolveExited(exit);
    this.onExit();
  }

  private failIdentity(error: unknown): void {
    if (this.exit) return;
    this.monitoring.abort();
    this.rejectExited(error);
    this.onExit(error);
  }

  private resultExit(): ProcessExit {
    return this.sourceExit ?? {};
  }

  private async monitorStarted(): Promise<void> {
    try {
      await this.raw?.exited;
      if (!this.identity) {
        this.finish(this.resultExit());
        return;
      }
      while (this.adapter.identityStatus(this.identity) === "running") {
        await this.clock.sleep(IDENTITY_POLL_MILLISECONDS, {
          signal: this.monitoring.signal,
        });
      }
      const status = this.adapter.identityStatus(this.identity);
      if (status === "changed") {
        this.failIdentity(
          new ProcessIdentityError(
            `Managed process ${this.name} changed operating-system identity.`,
          ),
        );
        return;
      }
      this.finish(this.resultExit());
    } catch (error) {
      this.failIdentity(error);
    }
  }

  private async monitorCaptured(): Promise<void> {
    if (!this.identity) return;
    try {
      while (true) {
        const status = this.adapter.identityStatus(this.identity);
        if (status === "missing") {
          this.finish({});
          return;
        }
        if (status === "changed") {
          this.failIdentity(
            new ProcessIdentityError(
              `Captured process ${this.name} changed operating-system identity.`,
            ),
          );
          return;
        }
        await this.clock.sleep(IDENTITY_POLL_MILLISECONDS, {
          signal: this.monitoring.signal,
        });
      }
    } catch (error) {
      this.failIdentity(error);
    }
  }

  private identityStatus(): ProcessIdentityStatus {
    if (!this.identity) return "missing";
    return this.adapter.identityStatus(this.identity);
  }

  private signalVerified(signal: NodeJS.Signals): boolean {
    const status = this.identityStatus();
    if (status === "missing") {
      this.finish({});
      return false;
    }
    if (status === "changed") {
      const error = new ProcessIdentityError(
        `Refusing to signal ${this.name}: operating-system identity changed.`,
      );
      this.failIdentity(error);
      throw error;
    }
    try {
      if (this.identity) this.adapter.signal(this.identity, signal);
      return true;
    } catch (error) {
      if (isMissingSignalError(error)) {
        this.finish({});
        return false;
      }
      throw error;
    }
  }

  stop(options: StopOptions = {}): Promise<ProcessExit> {
    this.stopPromise ??= this.stopOnce(options);
    return this.stopPromise;
  }

  private finishIfMissing(signal: NodeJS.Signals): void {
    if (this.identityStatus() === "missing") this.finish({ signal });
  }

  private async forceStop(
    gracefulTimeout: number,
    forceTimeout: number,
  ): Promise<ProcessExit> {
    this.logger.debug(
      `Managed process ${chalk.cyan(this.name)} did not stop after ${gracefulTimeout}ms, sending SIGKILL`,
    );
    if (!this.signalVerified("SIGKILL")) return await this.exited;
    this.finishIfMissing("SIGKILL");
    if (this.exit) return this.exit;
    const forced = await waitWithTimeout(this.exited, {
      clock: this.clock,
      milliseconds: forceTimeout,
    });
    if (forced.completed) return forced.value;
    this.unrefSurvivor();
    throw new ProcessShutdownError(
      `Failed to terminate managed process ${this.name} after SIGKILL.`,
      [
        {
          name: this.name,
          ...(this.identity ? { pid: this.identity.pid } : {}),
          phase: "forced",
        },
      ],
    );
  }

  private async stopOnce(options: StopOptions): Promise<ProcessExit> {
    if (this.exit) return this.exit;
    const gracefulSignal = options.signal ?? "SIGTERM";
    const gracefulTimeout =
      options.gracefulTimeoutMilliseconds ?? DEFAULT_STOP_TIMEOUT_MILLISECONDS;
    const forceTimeout =
      options.forceTimeoutMilliseconds ?? DEFAULT_STOP_TIMEOUT_MILLISECONDS;
    this.logger.debug(
      `Stopping managed process ${chalk.cyan(this.name)} with ${gracefulSignal}`,
    );
    try {
      if (!this.signalVerified(gracefulSignal)) return await this.exited;
      this.finishIfMissing(gracefulSignal);
      if (this.exit) return this.exit;
      const graceful = await waitWithTimeout(this.exited, {
        clock: this.clock,
        milliseconds: gracefulTimeout,
      });
      if (graceful.completed) return graceful.value;
      return await this.forceStop(gracefulTimeout, forceTimeout);
    } catch (error) {
      if (
        error instanceof ProcessShutdownError ||
        error instanceof ProcessIdentityError
      )
        throw error;
      throw new ProcessShutdownError(
        `Failed to stop managed process ${this.name}.`,
        [
          {
            name: this.name,
            ...(this.identity ? { pid: this.identity.pid } : {}),
            phase: "graceful",
            error,
          },
        ],
        { cause: error },
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.stop();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }
}

function createManagedStartedProcess<TResult>(options: {
  readonly request: StartProcessRequest;
  readonly raw: StartedProcess<TResult>;
  readonly adapter: ProcessAdapter;
  readonly clock: ProcessClock;
  readonly logger: ProcessLogger;
  readonly owned: Set<ManagedProcessHandle<unknown>>;
  readonly detach: (process: ManagedProcessHandle<unknown>) => void;
}): ManagedProcessHandle<TResult> {
  let managed: ManagedProcessHandle<TResult>;
  const remove = () => {
    options.owned.delete(managed as ManagedProcessHandle<unknown>);
    options.detach(managed as ManagedProcessHandle<unknown>);
  };
  managed = new ManagedProcessHandle(
    options.request.name ?? options.request.command,
    options.raw.result,
    options.raw.identity,
    options.adapter,
    options.clock,
    options.logger,
    options.raw,
    remove,
    options.request.lifetime === "detached" ? "detached" : "started",
  );
  options.owned.add(managed);
  return managed;
}

interface ForegroundRoute {
  readonly process: ManagedProcessHandle<unknown>;
  readonly forwardSignal?: (signal: NodeJS.Signals) => Promise<boolean>;
  readonly restoreTitle?: () => void;
  generation: number;
}

interface SignalRouter {
  readonly termination: Promise<NodeJS.Signals>;
  assertAvailable(): void;
  attach(
    process: ManagedProcessHandle<unknown>,
    interaction: Extract<
      StartProcessRequest,
      { readonly interaction: { readonly mode: "interactive" } }
    >["interaction"],
  ): void;
  detach(process: ManagedProcessHandle<unknown>): void;
  dispose(): void;
}

function createSignalRouter(options: {
  readonly adapter: ProcessAdapter;
  readonly logger: ProcessLogger;
  readonly forceStop: (
    excluded: ManagedProcessHandle<unknown> | undefined,
  ) => Promise<void>;
}): SignalRouter {
  let unsubscribe: (() => void) | undefined;
  let firstSignal: NodeJS.Signals | undefined;
  let forced = false;
  let foreground: ForegroundRoute | undefined;
  let resolveTermination: (signal: NodeJS.Signals) => void = () => undefined;
  const termination = new Promise<NodeJS.Signals>((resolve) => {
    resolveTermination = resolve;
  });

  function ensureSubscribed(): void {
    unsubscribe ??= options.adapter.subscribeToSignals(
      ["SIGINT", "SIGTERM", "SIGHUP"],
      (signal) => void receive(signal),
    );
  }

  function deliverLocal(
    route: ForegroundRoute,
    signal: NodeJS.Signals,
    generation: number,
  ): void {
    if (route.generation !== generation) return;
    route.process.signalForeground(signal);
  }

  async function deliver(
    route: ForegroundRoute,
    signal: NodeJS.Signals,
    generation: number,
  ): Promise<void> {
    if (!route.forwardSignal) {
      deliverLocal(route, signal, generation);
      return;
    }
    try {
      const handled = await route.forwardSignal(signal);
      if (!handled) deliverLocal(route, signal, generation);
    } catch (error) {
      const forwardingError = new SignalForwardingError(
        `Failed to forward ${signal} for ${route.process.name}: ${getErrorMessage(error)}`,
        { cause: error },
      );
      options.logger.error(forwardingError.message);
      options.logger.debug(
        `Signal forwarding diagnostics for ${route.process.name}:\n${formatErrorDiagnostics(forwardingError)}`,
      );
      deliverLocal(route, signal, generation);
    }
  }

  function deliverToForeground(signal: NodeJS.Signals): void {
    if (!foreground) return;
    foreground.generation += 1;
    void deliver(foreground, signal, foreground.generation);
  }

  async function receive(signal: NodeJS.Signals): Promise<void> {
    if (!firstSignal) {
      firstSignal = signal;
      resolveTermination(signal);
      deliverToForeground(signal);
      return;
    }
    if (forced) return;
    forced = true;
    const foregroundProcess = foreground?.process;
    deliverToForeground("SIGKILL");
    try {
      await options.forceStop(foregroundProcess);
    } catch (error) {
      options.logger.error(getErrorMessage(error));
      options.logger.debug(
        `Forced process shutdown diagnostics:\n${formatErrorDiagnostics(error)}`,
      );
    }
  }

  return {
    get termination() {
      ensureSubscribed();
      return termination;
    },
    assertAvailable() {
      if (foreground) {
        throw new Error(
          "Another interactive process already owns the terminal.",
        );
      }
    },
    attach(process, interaction) {
      ensureSubscribed();
      foreground = {
        process,
        ...(interaction.forwardSignal
          ? { forwardSignal: interaction.forwardSignal }
          : {}),
        ...(interaction.title
          ? { restoreTitle: options.adapter.setTitle(interaction.title) }
          : {}),
        generation: 0,
      };
    },
    detach(process) {
      if (foreground?.process !== process) return;
      foreground.restoreTitle?.();
      foreground = undefined;
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = undefined;
      foreground?.restoreTitle?.();
      foreground = undefined;
    },
  };
}

function reportSuppressedError(error: unknown): void {
  const logger = getLogger();
  logger.error(getErrorMessage(error));
  logger.debug(
    `Process cleanup diagnostics:\n${formatErrorDiagnostics(error)}`,
  );
}

function preserveResultAfterDisposalFailure(result: unknown): boolean {
  return typeof result === "number" && result !== 0;
}

export async function runWithProcessManager<T>(
  manager: ProcessManager,
  operation: () => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  let disposalError: unknown;
  try {
    await manager.dispose();
  } catch (error) {
    disposalError = error;
  }

  const cleanupError =
    disposalError === undefined
      ? undefined
      : new ProcessCleanupError(
          "Process manager disposal failed.",
          [disposalError],
          { cause: disposalError },
        );
  if (operationError !== undefined) {
    if (cleanupError !== undefined) {
      reportSuppressedError(cleanupError);
      if (operationError instanceof Error) {
        Object.defineProperty(operationError, "suppressedErrors", {
          configurable: true,
          enumerable: false,
          value: [cleanupError],
        });
      }
    }
    throw operationError;
  }
  if (cleanupError !== undefined) {
    if (preserveResultAfterDisposalFailure(result)) {
      reportSuppressedError(cleanupError);
      return result as T;
    }
    throw cleanupError;
  }
  return result as T;
}

function assertSuccessfulStops(
  outcomes: readonly PromiseSettledResult<ProcessExit>[],
): void {
  const failures = outcomes
    .filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    )
    .map((outcome) => outcome.reason);
  if (failures.length === 0) return;
  const shutdownTargets = failures.flatMap((failure) =>
    failure instanceof ProcessShutdownError
      ? failure.targets
      : [{ name: "unknown", phase: "graceful" as const, error: failure }],
  );
  const survivorMessage = shutdownTargets.every(
    (target) => target.phase === "forced",
  )
    ? `Failed to terminate managed processes after SIGKILL: ${shutdownTargets
        .map((target) => `${target.name} (pid ${target.pid ?? "unknown"})`)
        .join(", ")}`
    : `Failed to stop ${failures.length} managed process operation${failures.length === 1 ? "" : "s"}.`;
  throw new ProcessShutdownError(survivorMessage, shutdownTargets, {
    cause: failures.length === 1 ? failures[0] : new AggregateError(failures),
  });
}

export function createProcessManager(options: {
  readonly adapter: ProcessAdapter;
  readonly clock: ProcessClock;
  readonly logger?: Pick<Logger, "debug" | "warn" | "error">;
}): ProcessManager {
  const logger = options.logger ?? silentLogger;
  const owned = new Set<ManagedProcessHandle<unknown>>();
  let stopGeneration = 0;
  let stopping = false;
  let disposed = false;

  function assertStartAllowed(): void {
    if (disposed)
      throw new Error(
        "Process manager is disposed and cannot start processes.",
      );
    if (stopping) {
      throw new Error(
        `Process manager is stopping generation ${stopGeneration} and cannot start processes.`,
      );
    }
  }

  function start(request: StreamingProcessRequest): ManagedStreamingProcess;
  function start(
    request: StandardProcessRequest,
  ): ManagedProcess<ProcessResult>;
  function start(
    request: StartProcessRequest,
  ): ManagedProcess<ProcessResult> | ManagedStreamingProcess {
    validateStartRequest(request);
    assertStartAllowed();
    logger.debug(
      `Starting managed process ${chalk.cyan(request.name ?? request.command)}`,
    );
    if (request.interaction.mode === "interactive") {
      signalRouter.assertAvailable();
    }
    if (request.stdio === "stream") {
      const raw = options.adapter.start(request);
      const managed = createManagedStartedProcess<StreamingProcessResult>({
        request,
        raw,
        adapter: options.adapter,
        clock: options.clock,
        logger,
        owned,
        detach: (process) => signalRouter.detach(process),
      });
      managed.beginMonitoring();
      return Object.assign(managed, {
        stdin: raw.stdin,
        stdout: raw.stdout,
        stderr: raw.stderr,
      });
    }
    const raw = options.adapter.start(request);
    const managed = createManagedStartedProcess<ProcessResult>({
      request,
      raw,
      adapter: options.adapter,
      clock: options.clock,
      logger,
      owned,
      detach: (process) => signalRouter.detach(process),
    });
    if (request.lifetime === "detached") {
      managed.unrefSurvivor();
      owned.delete(managed);
      managed.beginMonitoring();
      return managed;
    }
    if (request.interaction.mode === "interactive") {
      signalRouter.attach(managed, request.interaction);
    }
    managed.beginMonitoring();
    return managed;
  }

  function capture(
    request: CaptureProcessRequest,
  ): ManagedProcess<CapturedProcessResult> | undefined {
    assertStartAllowed();
    logger.debug(`Capturing managed process ${chalk.cyan(request.name)}`);
    const captureResult = options.adapter.capture(request.pid);
    if (captureResult.status === "missing") return undefined;
    if (captureResult.status === "unsupported") {
      throw new ProcessIdentityError(
        `Cannot capture ${request.name}: ${captureResult.reason}`,
      );
    }
    const { identity } = captureResult;
    let managed: ManagedProcessHandle<CapturedProcessResult>;
    let resolveResult: (result: CapturedProcessResult) => void = () =>
      undefined;
    let rejectResult: (error: unknown) => void = () => undefined;
    const result = new Promise<CapturedProcessResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    managed = new ManagedProcessHandle(
      request.name,
      result,
      identity,
      options.adapter,
      options.clock,
      logger,
      undefined,
      (error) => {
        owned.delete(managed as ManagedProcessHandle<unknown>);
        if (error === undefined) resolveResult({ reason: "disappeared" });
        else rejectResult(error);
      },
      "captured",
    );
    owned.add(managed);
    managed.beginMonitoring();
    return managed;
  }

  async function stopOwned(
    stopOptions: StopOptions,
    excluded?: ManagedProcessHandle<unknown>,
  ): Promise<void> {
    if (stopping)
      throw new Error("Process manager stopAll() is already in progress.");
    if (disposed && owned.size === 0) return;
    stopping = true;
    stopGeneration += 1;
    const targets = [...owned].filter((target) => target !== excluded);
    try {
      const outcomes = await Promise.allSettled(
        targets.map((managedProcess) => managedProcess.stop(stopOptions)),
      );
      assertSuccessfulStops(outcomes);
    } finally {
      stopping = false;
    }
  }

  function stopAll(stopOptions: StopOptions = {}): Promise<void> {
    return stopOwned(stopOptions);
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    let failure: unknown;
    try {
      await stopAll();
    } catch (error) {
      failure = error;
    } finally {
      signalRouter.dispose();
    }
    if (failure) throw failure;
  }

  const signalRouter = createSignalRouter({
    adapter: options.adapter,
    logger,
    forceStop: (excluded) =>
      stopOwned(
        {
          signal: "SIGKILL",
          gracefulTimeoutMilliseconds: 1,
          forceTimeoutMilliseconds: 1,
        },
        excluded,
      ),
  });
  const manager: ProcessManager = {
    get termination() {
      return signalRouter.termination;
    },
    start,
    capture,
    stopAll,
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
  return manager;
}
