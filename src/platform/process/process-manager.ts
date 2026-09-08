import {
  createDependency,
  type DependencyBinding,
} from "#platform/dependency-injection/index.js";

/** @lintignore Public process lifetime dimension. */
export type ProcessLifetime = "application" | "detached";

/** @lintignore Public process interaction dimension. */
export type ProcessInteraction =
  | { readonly mode: "non-interactive" }
  | {
      readonly mode: "interactive";
      readonly title?: string;
      readonly forwardSignal?: (signal: NodeJS.Signals) => Promise<boolean>;
    };

interface ProcessRequestBase {
  readonly name?: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** @lintignore Public application process request. */
export interface ApplicationProcessRequest extends ProcessRequestBase {
  readonly lifetime: "application";
  readonly interaction: { readonly mode: "non-interactive" };
  readonly stdio?: "capture" | "inherit" | "ignore";
  readonly stdin?: "inherit" | "ignore";
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
  readonly stdoutFile?: { readonly path: string; readonly append: boolean };
}

/** @lintignore Public interactive process request. */
export interface InteractiveApplicationProcessRequest
  extends ProcessRequestBase {
  readonly lifetime: "application";
  readonly interaction: {
    readonly mode: "interactive";
    readonly title?: string;
    readonly forwardSignal?: (signal: NodeJS.Signals) => Promise<boolean>;
  };
  readonly stdio?: "inherit";
  readonly stdin?: "inherit";
  readonly onStdout?: never;
  readonly onStderr?: never;
  readonly stdoutFile?: never;
}

/** @lintignore Public detached process request. */
export interface DetachedProcessRequest extends ProcessRequestBase {
  readonly lifetime: "detached";
  readonly interaction: { readonly mode: "non-interactive" };
  readonly stdio?: "ignore";
  readonly stdin?: "ignore";
  readonly onStdout?: never;
  readonly onStderr?: never;
  readonly stdoutFile?: { readonly path: string; readonly append: boolean };
}

/** @lintignore Public standard process start request union. */
export type StandardProcessRequest =
  | ApplicationProcessRequest
  | InteractiveApplicationProcessRequest
  | DetachedProcessRequest;

/** @lintignore Public streaming process request. */
export interface StreamingProcessRequest extends ProcessRequestBase {
  readonly lifetime: "application";
  readonly interaction: { readonly mode: "non-interactive" };
  readonly stdio: "stream";
  readonly stdin?: never;
  readonly onStdout?: never;
  readonly onStderr?: never;
  readonly stdoutFile?: never;
}

/** @lintignore Public process start request union. */
export type StartProcessRequest =
  | StandardProcessRequest
  | StreamingProcessRequest;

/** @lintignore Public process capture request. */
export interface CaptureProcessRequest {
  readonly name: string;
  readonly pid: number;
}

/** @lintignore Public child process result. */
export interface ProcessResult {
  readonly exitCode: number;
  readonly signal?: NodeJS.Signals;
  readonly stdout: string;
  readonly stderr: string;
}

/** @lintignore Public streaming child process result. */
export interface StreamingProcessResult {
  readonly exitCode: number;
  readonly signal?: NodeJS.Signals;
}

/** @lintignore Public streaming child input. */
export interface ProcessInput {
  write(chunk: Uint8Array): Promise<void>;
  end(): Promise<void>;
}

/** @lintignore Public captured process result. */
export interface CapturedProcessResult {
  readonly reason: "disappeared";
}

/** @lintignore Public authoritative process exit. */
export interface ProcessExit {
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
}

/** @lintignore Public managed process stop options. */
export interface StopOptions {
  readonly signal?: NodeJS.Signals;
  readonly gracefulTimeoutMilliseconds?: number;
  readonly forceTimeoutMilliseconds?: number;
}

/** @lintignore Public generic managed process resource. */
export interface ManagedProcess<TResult> extends AsyncDisposable {
  readonly name: string;
  readonly result: Promise<TResult>;
  readonly exited: Promise<ProcessExit>;
  stop(options?: StopOptions): Promise<ProcessExit>;
  dispose(): Promise<void>;
}

/** @lintignore Public managed streaming process resource. */
export interface ManagedStreamingProcess
  extends ManagedProcess<StreamingProcessResult> {
  readonly stdin: ProcessInput;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
}

/** @lintignore Public application-scoped process manager. */
export interface ProcessManager extends AsyncDisposable {
  readonly termination: Promise<NodeJS.Signals>;
  start(request: StreamingProcessRequest): ManagedStreamingProcess;
  start(request: StandardProcessRequest): ManagedProcess<ProcessResult>;
  capture(
    request: CaptureProcessRequest,
  ): ManagedProcess<CapturedProcessResult> | undefined;
  stopAll(options?: StopOptions): Promise<void>;
  dispose(): Promise<void>;
}

/** @lintignore Public structured shutdown target. */
export interface ProcessShutdownTarget {
  readonly name: string;
  readonly pid?: number;
  readonly phase: "graceful" | "forced" | "identity";
  readonly error?: unknown;
}

/** @lintignore Public managed process shutdown error. */
export class ProcessShutdownError extends Error {
  constructor(
    message: string,
    readonly targets: readonly ProcessShutdownTarget[],
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "ProcessShutdownError";
  }
}

/** @lintignore Public process cleanup error. */
export class ProcessCleanupError extends Error {
  constructor(
    message: string,
    readonly suppressedErrors: readonly unknown[],
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "ProcessCleanupError";
  }
}

/** @lintignore Public process identity safety error. */
export class ProcessIdentityError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options);
    this.name = "ProcessIdentityError";
  }
}

/** @lintignore Public signal forwarding error. */
export class SignalForwardingError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options);
    this.name = "SignalForwardingError";
  }
}

const processManagerDependency =
  createDependency<ProcessManager>("process manager");

export function provideProcessManager(
  manager: ProcessManager,
): DependencyBinding {
  return processManagerDependency.provide(manager);
}

export function getProcessManager(): ProcessManager {
  return processManagerDependency.get();
}
