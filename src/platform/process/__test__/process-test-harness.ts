import type { Clock } from "#platform/clock/index.js";
import { getClock } from "#platform/clock/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { getExitCodeForSignal } from "../exit-code.js";
import type {
  ProcessAdapter,
  ProcessIdentity,
  StartedProcess,
  StartedStreamingProcess,
} from "../process-adapter.js";
import { createProcessManager } from "../process-lifecycle.js";
import {
  type ProcessInput,
  type ProcessManager,
  type ProcessResult,
  provideProcessManager,
  type StandardProcessRequest,
  type StartProcessRequest,
  type StreamingProcessRequest,
  type StreamingProcessResult,
} from "../process-manager.js";

export interface ProcessTestRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdio?: "capture" | "inherit" | "ignore" | "stream";
  readonly signal?: AbortSignal;
  readonly name?: string;
  readonly stdin?: "inherit" | "ignore";
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
  readonly detached?: boolean;
  readonly stdoutFile?: { readonly path: string; readonly append: boolean };
}

export type ProcessTestAction =
  | {
      readonly type: "start";
      readonly process: TestProcess;
      readonly request: ProcessTestRequest;
    }
  | {
      readonly type: "signal";
      readonly process: TestProcess;
      readonly signal: NodeJS.Signals;
    }
  | { readonly type: "unref"; readonly process: TestProcess };

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

type ProcessTestMatch = Partial<
  Pick<ProcessTestRequest, "command" | "args" | "name" | "stdio">
>;

interface ProcessExitOptions {
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  readonly stdout?: string;
  readonly stderr?: string;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  };
}

class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  private readonly chunks: Uint8Array[] = [];
  private readonly readers: Deferred<IteratorResult<Uint8Array>>[] = [];
  private ended = false;
  private failure: unknown;

  push(chunk: string | Uint8Array): void {
    if (this.ended || this.failure !== undefined) return;
    const bytes =
      typeof chunk === "string" ? Buffer.from(chunk) : Uint8Array.from(chunk);
    const reader = this.readers.shift();
    if (reader) reader.resolve({ done: false, value: bytes });
    else this.chunks.push(bytes);
  }

  end(): void {
    if (this.ended || this.failure !== undefined) return;
    this.ended = true;
    for (const reader of this.readers) {
      reader.resolve({ done: true, value: undefined });
    }
    this.readers.length = 0;
  }

  fail(error: unknown): void {
    if (this.ended || this.failure !== undefined) return;
    this.failure = error;
    for (const reader of this.readers) reader.reject(error);
    this.readers.length = 0;
  }

  next(): Promise<IteratorResult<Uint8Array>> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const chunk = this.chunks.shift();
    if (chunk) return Promise.resolve({ done: false, value: chunk });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    const reader = deferred<IteratorResult<Uint8Array>>();
    this.readers.push(reader);
    return reader.promise;
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return { next: () => this.next() };
  }
}

function disposalError(): DOMException {
  return new DOMException(
    "The process test harness was disposed",
    "AbortError",
  );
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function validateResult(result: ProcessResult): ProcessResult {
  if (!result.signal) return result;
  const expected = getExitCodeForSignal(result.signal);
  if (result.exitCode === expected) return result;
  throw new Error(
    `Signal ${result.signal} requires exit code ${expected}, received ${result.exitCode}.`,
  );
}

export interface TestProcess {
  readonly pid: number | undefined;
  readonly name: string | undefined;
  readonly signals: readonly NodeJS.Signals[];
  waitForStart(): Promise<ProcessTestRequest>;
  waitForSignal(): Promise<NodeJS.Signals>;
  resolveResult(result: ProcessResult, processRemainsRunning?: boolean): void;
  rejectResult(error: Error, processRemainsRunning?: boolean): void;
  exit(options?: ProcessExitOptions): void;
  disappear(): void;
  changeIdentity(): void;
  failSignalsWith(error: Error): void;
  exitOnSignal(signal?: NodeJS.Signals): void;
  emitStdout(chunk: string | Uint8Array): void;
  emitStderr(chunk: string | Uint8Array): void;
  waitForInput(): Promise<Uint8Array>;
  waitForInputEnd(): Promise<void>;
  pauseInput(): () => void;
  failInput(error: Error): void;
  failStream(error: Error): void;
}

class TestProcessRecord implements TestProcess {
  private readonly result = deferred<ProcessResult>();
  private readonly exited = deferred<void>();
  private readonly started = deferred<ProcessTestRequest>();
  private readonly signalReceived = deferred<NodeJS.Signals>();
  private readonly receivedSignals: NodeJS.Signals[] = [];
  private request: ProcessTestRequest | undefined;
  private assignedPid: number | undefined;
  private identityToken = 1;
  private running = false;
  private settled = false;
  private signalFailure: Error | undefined;
  private exitSignal: NodeJS.Signals | "any" | undefined;
  private stdout = "";
  private readonly streamingStdout = new AsyncByteQueue();
  private readonly streamingStderr = new AsyncByteQueue();
  private readonly input = new AsyncByteQueue();
  private readonly inputEnded = deferred<void>();
  private inputBarrier: Deferred<void> | undefined;
  private inputFailure: Error | undefined;

  constructor(
    private readonly external: boolean,
    private readonly rejectOnAbort = false,
  ) {
    void this.result.promise.catch(() => undefined);
    void this.started.promise.catch(() => undefined);
    void this.signalReceived.promise.catch(() => undefined);
    void this.inputEnded.promise.catch(() => undefined);
  }

  get pid(): number | undefined {
    return this.assignedPid;
  }

  get name(): string | undefined {
    return this.request?.name;
  }

  get signals(): readonly NodeJS.Signals[] {
    return [...this.receivedSignals];
  }

  waitForStart(): Promise<ProcessTestRequest> {
    return this.request ? Promise.resolve(this.request) : this.started.promise;
  }

  waitForSignal(): Promise<NodeJS.Signals> {
    const received = this.receivedSignals.at(-1);
    if (received) return Promise.resolve(received);
    if (this.settled || !this.running) {
      return Promise.reject(
        new Error("Test process settled before receiving a signal."),
      );
    }
    return this.signalReceived.promise;
  }

  resolveResult(result: ProcessResult, processRemainsRunning = false): void {
    this.streamingStdout.end();
    this.streamingStderr.end();
    this.input.end();
    this.inputEnded.resolve();
    this.inputBarrier?.reject(new Error("Test process has exited."));
    this.inputBarrier = undefined;
    this.settle(() => {
      try {
        this.result.resolve(validateResult(result));
      } catch (error) {
        this.result.reject(error);
      }
    }, processRemainsRunning);
  }

  rejectResult(error: Error, processRemainsRunning = false): void {
    this.streamingStdout.fail(error);
    this.streamingStderr.fail(error);
    this.input.fail(error);
    this.inputEnded.reject(error);
    this.inputBarrier?.reject(error);
    this.inputBarrier = undefined;
    this.settle(() => this.result.reject(error), processRemainsRunning, error);
  }

  exit(options: ProcessExitOptions = {}): void {
    this.resolveResult({
      exitCode:
        options.exitCode ??
        (options.signal ? getExitCodeForSignal(options.signal) : 0),
      ...(options.signal ? { signal: options.signal } : {}),
      stdout: options.stdout ?? this.stdout.trimEnd(),
      stderr: options.stderr ?? "",
    });
  }

  disappear(): void {
    this.running = false;
    this.exited.resolve();
  }

  changeIdentity(): void {
    if (!this.running) {
      throw new Error(
        `Process ${this.assignedPid ?? "unassigned"} is not running.`,
      );
    }
    this.identityToken += 1;
  }

  failSignalsWith(error: Error): void {
    this.signalFailure = error;
  }

  exitOnSignal(signal?: NodeJS.Signals): void {
    this.exitSignal = signal ?? "any";
  }

  emitStdout(chunk: string | Uint8Array): void {
    const buffer = Buffer.from(chunk);
    this.stdout += buffer.toString();
    this.request?.onStdout?.(buffer);
    this.streamingStdout.push(buffer);
  }

  emitStderr(chunk: string | Uint8Array): void {
    const buffer = Buffer.from(chunk);
    this.request?.onStderr?.(buffer);
    this.streamingStderr.push(buffer);
  }

  async waitForInput(): Promise<Uint8Array> {
    const result = await this.input.next();
    if (result.done) {
      throw new Error("Test process input ended before receiving a chunk.");
    }
    return result.value;
  }

  waitForInputEnd(): Promise<void> {
    return this.inputEnded.promise;
  }

  pauseInput(): () => void {
    if (this.inputBarrier) {
      throw new Error("Test process input is already paused.");
    }
    const barrier = deferred<void>();
    this.inputBarrier = barrier;
    return () => {
      if (this.inputBarrier !== barrier) return;
      this.inputBarrier = undefined;
      barrier.resolve();
    };
  }

  failStream(error: Error): void {
    this.rejectResult(error);
  }

  assign(pid: number, request?: ProcessTestRequest): void {
    if (this.assignedPid !== undefined) {
      throw new Error(`Test process already has PID ${this.assignedPid}.`);
    }
    this.assignedPid = pid;
    this.request = request;
    if (!this.settled) this.running = true;
    if (request) this.started.resolve(request);
  }

  isRunning(): boolean {
    return this.running;
  }

  identity(): ProcessIdentity & { readonly token: number } {
    if (this.assignedPid === undefined) {
      throw new Error("Test process has not been assigned a PID.");
    }
    return { pid: this.assignedPid, token: this.identityToken };
  }

  identityStatus(identity: ProcessIdentity): "running" | "missing" | "changed" {
    if (!this.running) return "missing";
    return identity.token === this.identityToken ? "running" : "changed";
  }

  startedProcess(signal?: AbortSignal): StartedProcess {
    if (signal?.aborted) this.rejectResult(abortReason(signal));
    const abort = () => {
      if (signal && this.rejectOnAbort && !this.settled) {
        this.rejectResult(abortReason(signal));
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    void this.result.promise
      .finally(() => signal?.removeEventListener("abort", abort))
      .catch(() => undefined);
    return {
      identity: this.identity(),
      result: this.result.promise,
      exited: this.exited.promise,
    };
  }

  failInput(error: Error): void {
    this.inputFailure ??= error;
    this.inputBarrier?.reject(error);
    this.inputBarrier = undefined;
  }

  startedStreamingProcess(signal?: AbortSignal): StartedStreamingProcess {
    const started = this.startedProcess(signal);
    const stdin: ProcessInput = {
      write: async (chunk) => {
        if (this.inputFailure) throw this.inputFailure;
        if (this.settled) throw new Error("Test process has exited.");
        this.input.push(chunk);
        await this.inputBarrier?.promise;
        if (this.inputFailure) throw this.inputFailure;
        if (this.settled) throw new Error("Test process has exited.");
      },
      end: async () => {
        this.input.end();
        this.inputEnded.resolve();
      },
    };
    const result = started.result.then<StreamingProcessResult>((value) => ({
      exitCode: value.exitCode,
      ...(value.signal ? { signal: value.signal } : {}),
    }));
    return {
      identity: started.identity,
      result,
      exited: started.exited,
      stdin,
      stdout: this.streamingStdout,
      stderr: this.streamingStderr,
    };
  }

  receiveSignal(signal: NodeJS.Signals): void {
    this.receivedSignals.push(signal);
    this.signalReceived.resolve(signal);
    if (this.signalFailure) throw this.signalFailure;
    if (this.exitSignal !== "any" && this.exitSignal !== signal) return;
    if (this.external || this.settled) this.disappear();
    else this.exit({ signal });
  }

  dispose(error: Error): void {
    this.running = false;
    this.streamingStdout.fail(error);
    this.streamingStderr.fail(error);
    this.input.fail(error);
    this.inputEnded.reject(error);
    this.inputBarrier?.reject(error);
    this.inputBarrier = undefined;
    if (!this.settled) {
      this.settled = true;
      this.result.reject(error);
    }
    this.exited.resolve();
    if (!this.request) this.started.reject(error);
    this.signalReceived.reject(error);
  }

  private settle(
    complete: () => void,
    keepRunning: boolean,
    waiterError = new Error("Test process settled before receiving a signal."),
  ): void {
    if (this.settled) throw new Error("Test process is already settled.");
    this.settled = true;
    this.running = keepRunning;
    this.signalReceived.reject(waiterError);
    complete();
    if (!keepRunning) this.disappear();
  }
}

interface StartExpectation {
  readonly match: ProcessTestMatch;
  readonly process: TestProcessRecord;
}

export interface ProcessTestHarness {
  readonly manager: ProcessManager;
  readonly requests: readonly ProcessTestRequest[];
  readonly titles: {
    current(): string | null;
    history(): readonly string[];
  };
  run<T>(operation: () => T): T;
  expectStart(options?: {
    readonly match?: ProcessTestMatch;
    readonly rejectOnAbort?: true;
  }): TestProcess;
  addExternalProcess(options: {
    readonly pid: number;
    readonly name?: string;
  }): TestProcess;
  actions(): readonly ProcessTestAction[];
  emitTermination(signal: NodeJS.Signals): void;
  listenerCount(): number;
  pendingProcesses(): number;
  dispose(): Promise<void>;
}

function cloneRequest(request: StartProcessRequest): ProcessTestRequest {
  const { lifetime, interaction, stdio, ...observed } = request;
  return {
    ...observed,
    ...(request.args ? { args: [...request.args] } : {}),
    ...(request.env ? { env: { ...request.env } } : {}),
    ...(request.stdoutFile ? { stdoutFile: { ...request.stdoutFile } } : {}),
    ...(interaction.mode === "interactive"
      ? { stdio: "inherit" as const }
      : stdio
        ? { stdio }
        : {}),
    ...(lifetime === "detached" ? { detached: true } : {}),
  };
}

function matches(
  request: ProcessTestRequest,
  match: ProcessTestMatch,
): boolean {
  return Object.entries(match).every(([key, expected]) => {
    const actual = request[key as keyof ProcessTestMatch];
    return Array.isArray(expected)
      ? Array.isArray(actual) &&
          expected.length === actual.length &&
          expected.every((value, index) => value === actual[index])
      : actual === expected;
  });
}

function unexpectedRequest(request: ProcessTestRequest): StartedProcess {
  return {
    result: Promise.reject(unexpectedRequestError(request)),
    exited: Promise.resolve(),
  };
}

function unexpectedRequestError(request: ProcessTestRequest): Error {
  return new Error(
    `Unexpected process request: command=${JSON.stringify(request.command)}, args=${JSON.stringify(request.args ?? [])}, mode=spawn.`,
  );
}

function failedStreamingProcess(error: Error): StartedStreamingProcess {
  const output = new AsyncByteQueue();
  output.fail(error);
  return {
    result: Promise.reject(error),
    exited: Promise.resolve(),
    stdin: {
      write: () => Promise.reject(error),
      end: () => Promise.reject(error),
    },
    stdout: output,
    stderr: output,
  };
}

export function createProcessTestHarness(clock?: Clock): ProcessTestHarness {
  const expectations: StartExpectation[] = [];
  const requests: ProcessTestRequest[] = [];
  const processes = new Map<number, TestProcessRecord>();
  const actions: ProcessTestAction[] = [];
  const listeners = new Set<(signal: NodeJS.Signals) => void>();
  const titleHistory: string[] = [];
  let currentTitle: string | null = null;
  let nextPid = 1_000;
  let disposed = false;

  function start(request: StreamingProcessRequest): StartedStreamingProcess;
  function start(request: StandardProcessRequest): StartedProcess;
  function start(
    request: StartProcessRequest,
  ): StartedProcess | StartedStreamingProcess {
    const observed = cloneRequest(request);
    if (disposed) {
      return request.stdio === "stream"
        ? failedStreamingProcess(disposalError())
        : {
            result: Promise.reject<ProcessResult>(disposalError()),
            exited: Promise.resolve(),
          };
    }
    requests.push(observed);
    const index = expectations.findLastIndex((candidate) =>
      matches(observed, candidate.match),
    );
    const expectation =
      index < 0 ? undefined : expectations.splice(index, 1)[0];
    if (!expectation) {
      return request.stdio === "stream"
        ? failedStreamingProcess(unexpectedRequestError(observed))
        : unexpectedRequest(observed);
    }
    const process = expectation.process;
    process.assign(nextPid++, observed);
    processes.set(process.identity().pid, process);
    actions.push({ type: "start", process, request: observed });
    return request.stdio === "stream"
      ? process.startedStreamingProcess(request.signal)
      : process.startedProcess(request.signal);
  }

  const adapter: ProcessAdapter = {
    start,
    capture(pid) {
      const process = processes.get(pid);
      if (!process?.isRunning()) return { status: "missing" };
      return { status: "captured", identity: process.identity() };
    },
    identityStatus(identity) {
      return processes.get(identity.pid)?.identityStatus(identity) ?? "missing";
    },
    signal(identity, signal) {
      const process = processes.get(identity.pid);
      if (!process) return;
      actions.push({ type: "signal", process, signal });
      process.receiveSignal(signal);
    },
    unref(identity) {
      const process = processes.get(identity.pid);
      if (process) actions.push({ type: "unref", process });
    },
    subscribeToSignals(signals, listener) {
      if (disposed) throw disposalError();
      const accepted = new Set(signals);
      const filtered = (signal: NodeJS.Signals) => {
        if (accepted.has(signal)) listener(signal);
      };
      listeners.add(filtered);
      return () => listeners.delete(filtered);
    },
    setTitle(title) {
      const previous = currentTitle;
      currentTitle = title;
      titleHistory.push(title);
      return () => {
        currentTitle = previous;
      };
    },
  };
  const manager = createProcessManager({
    adapter,
    clock: clock ?? {
      sleep: (milliseconds, options) => getClock().sleep(milliseconds, options),
    },
  });

  return {
    manager,
    requests,
    titles: {
      current: () => currentTitle,
      history: () => [...titleHistory],
    },
    run: (operation) =>
      runWithDependencies([provideProcessManager(manager)], operation),
    expectStart(options = {}) {
      const process = new TestProcessRecord(false, options.rejectOnAbort);
      expectations.push({ match: options.match ?? {}, process });
      return process;
    },
    addExternalProcess(options) {
      if (processes.has(options.pid)) {
        throw new Error(`Process ${options.pid} already exists.`);
      }
      const process = new TestProcessRecord(true);
      process.assign(
        options.pid,
        options.name
          ? { command: options.name, name: options.name }
          : undefined,
      );
      processes.set(options.pid, process);
      return process;
    },
    actions: () => [...actions],
    emitTermination(signal) {
      for (const listener of listeners) listener(signal);
    },
    listenerCount: () => listeners.size,
    pendingProcesses: () =>
      [...processes.values()].filter((process) => process.isRunning()).length,
    async dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      const error = disposalError();
      for (const expectation of expectations)
        expectation.process.dispose(error);
      expectations.length = 0;
      for (const process of processes.values()) process.dispose(error);
      await Promise.resolve();
    },
  };
}
