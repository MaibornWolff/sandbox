import type {
  ProcessInput,
  ProcessResult,
  StandardProcessRequest,
  StreamingProcessRequest,
  StreamingProcessResult,
} from "./process-manager.js";

export interface ProcessIdentity {
  readonly pid: number;
  readonly token: unknown;
}

export type ProcessIdentityStatus = "running" | "missing" | "changed";

export interface StartedProcess<TResult = ProcessResult> {
  readonly identity?: ProcessIdentity;
  readonly result: Promise<TResult>;
  readonly exited: Promise<void>;
}

export interface StartedStreamingProcess
  extends StartedProcess<StreamingProcessResult> {
  readonly stdin: ProcessInput;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
}

interface CapturedProcessIdentity extends ProcessIdentity {
  readonly token: string | number;
}

export type CaptureIdentityResult =
  | { readonly status: "captured"; readonly identity: CapturedProcessIdentity }
  | { readonly status: "missing" }
  | { readonly status: "unsupported"; readonly reason: string };

export interface ProcessAdapter {
  start(request: StreamingProcessRequest): StartedStreamingProcess;
  start(request: StandardProcessRequest): StartedProcess;
  capture(pid: number): CaptureIdentityResult;
  identityStatus(identity: ProcessIdentity): ProcessIdentityStatus;
  signal(identity: ProcessIdentity, signal: NodeJS.Signals): void;
  unref(identity: ProcessIdentity): void;
  subscribeToSignals(
    signals: readonly NodeJS.Signals[],
    listener: (signal: NodeJS.Signals) => void,
  ): () => void;
  setTitle(title: string): () => void;
}
