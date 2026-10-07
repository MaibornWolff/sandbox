import type { ProcessResult } from "#platform/process/index.js";
import type { SandboxExecProcess } from "./container-contract.js";

export type { SandboxExecProcess } from "./container-contract.js";

import type { Runtime } from "./runtime-types.js";

export interface SandboxImageBuilder {
  isAvailable(image: SandboxImage): Promise<boolean>;
  build(request: SandboxImageBuildRequest): Promise<SandboxImage>;
  removeUnused(
    request: SandboxImageCleanupRequest,
  ): Promise<SandboxImageCleanupResult>;
}

export interface SandboxImage {
  readonly reference: string;
  readonly digest: string;
}

export interface SandboxImageBuildRequest {
  readonly contextDirectory: string;
  readonly dockerfilePath: string;
  readonly tag: string;
  readonly buildArguments: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly secrets: readonly SandboxImageBuildSecret[];
  readonly cachePolicy: "use" | "bypass";
  /** Preserve interactive build output when the command is user-facing. */
  readonly output: "interactive" | "silent";
}

export interface SandboxImageBuildSecret {
  readonly id: string;
  readonly environmentVariable: string;
}

export interface SandboxImageCleanupRequest {
  readonly candidates: readonly string[];
  readonly managedLabel: { readonly key: string; readonly value: string };
}

export interface SandboxImageCleanupResult {
  readonly removed: readonly SandboxImageCleanupRemoval[];
  readonly skipped: readonly SandboxImageCleanupSkip[];
  readonly estimatedReclaimedBytes: number;
}

export interface SandboxImageCleanupRemoval {
  readonly digest: string;
  readonly estimatedReclaimedBytes: number;
}

export interface SandboxImageCleanupSkip {
  readonly digest: string;
  readonly reason: "missing" | "unmanaged" | "tagged" | "in-use";
}

export interface SandboxRuntime {
  readonly runtime: Runtime;
  readonly instances: SandboxInstanceOperations;
  readonly storage: SandboxStorageOperations;
  ensureHostReady(): Promise<SandboxRuntimeInfo>;
  getCompatibilityIdentity(): Promise<string>;
  /** Share discovery through hash, reuse, and creation. Await all startup work inside the callback, but keep attached sessions outside it. */
  withInstanceStartup<T>(operation: () => Promise<T>): Promise<T>;
  getDiskSpaceAdvice(): string;
}

export interface SandboxRuntimeInfo {
  readonly version: string;
  readonly hostAccessName: string;
  readonly memory: SandboxRuntimeMemoryInfo;
}

export type SandboxRuntimeMemoryInfo =
  | {
      readonly bytes: number;
      readonly scope: "shared-runtime-vm" | "per-instance-default";
    }
  | { readonly bytes: null; readonly scope: "unknown" };

export interface SandboxStorageOperations {
  ensure(spec: SandboxStorageSpec): Promise<SandboxStorage>;
  find(spec: SandboxStorageSpec): Promise<SandboxStorage | null>;
  remove(storage: SandboxStorage): Promise<void>;
}

export interface SandboxStorageSpec {
  readonly key: string;
  readonly scope: "global" | "project";
}

export interface SandboxStorage {
  readonly id: string;
}

export class SandboxInstanceNameConflictError extends Error {
  constructor(name: string, options?: ErrorOptions) {
    super(`Sandbox instance name is already in use: ${name}`, options);
  }
}

export interface SandboxInstanceOperations {
  list(query?: SandboxInstanceQuery): Promise<SandboxInstanceSummary[]>;
  inspect(id: string): Promise<SandboxInstanceDetails | null>;
  startDetached(spec: SandboxInstanceSpec): Promise<SandboxInstanceReference>;
  runAttached(
    spec: SandboxInstanceSpec,
    session: TerminalSessionOptions,
  ): Promise<CommandResult>;
  signal(id: string, signal: NodeJS.Signals): Promise<void>;
  stopAndRemove(id: string): Promise<void>;
  remove(id: string, options?: SandboxInstanceRemoveOptions): Promise<void>;
  exec(id: string, spec: SandboxExecSpec): Promise<CommandResult>;
  openExec(id: string, spec: SandboxExecSpec): Promise<SandboxExecProcess>;
  execAttached(
    id: string,
    spec: SandboxExecSpec,
    session: TerminalSessionOptions,
  ): Promise<CommandResult>;
  readLogs(id: string, query?: SandboxLogQuery): Promise<string>;
  followLogs(
    id: string,
    request: SandboxLogFollowRequest,
  ): SandboxLogSubscription;
}

export interface SandboxInstanceQuery {
  readonly all?: boolean;
  readonly labels?: Readonly<Record<string, string | null>>;
  readonly states?: readonly SandboxInstanceState[];
}

export interface SandboxInstanceSummary {
  readonly id: string;
  readonly name: string;
  readonly image: SandboxImage;
  readonly labels: Readonly<Record<string, string>>;
  readonly state: SandboxInstanceState;
}

export interface SandboxInstanceDetails extends SandboxInstanceSummary {
  readonly startedAt: Date | null;
  readonly mounts: readonly SandboxMount[];
}

export interface SandboxInstanceReference {
  readonly id: string;
}

export type SandboxInstanceState =
  | "created"
  | "running"
  | "paused"
  | "restarting"
  | "stopping"
  | "exited"
  | "dead"
  | "unknown";

export interface SandboxInstanceSpec {
  readonly name: string;
  readonly image: SandboxImage;
  readonly labels: Readonly<Record<string, string>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly mounts: readonly SandboxMount[];
  readonly ports: readonly PublishedPort[];
  readonly init: boolean;
  readonly removeOnExit: boolean;
  readonly resources: SandboxResources;
  readonly security: SandboxSecurity;
}

export type SandboxMount =
  | {
      readonly type: "storage";
      readonly storage: SandboxStorage;
      readonly targetPath: string;
      readonly readOnly: boolean;
    }
  | {
      readonly type: "workspace";
      readonly sourcePath: string;
      readonly targetPath: string;
      readonly readOnly: boolean;
    };

export interface PublishedPort {
  readonly hostAddress?: string;
  readonly hostPort: number;
  readonly instancePort: number;
  readonly protocol: "tcp" | "udp";
}

export interface SandboxResources {
  readonly memoryBytes?: number;
  readonly sharedMemorySize?: string;
}

export interface SandboxSecurity {
  readonly capabilities: readonly string[];
  readonly nestedContainerRuntime: boolean;
}

export interface SandboxExecSpec {
  readonly command: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly workingDirectory?: string;
  readonly user?: string;
}

export interface TerminalSessionOptions {
  readonly attachStdin: boolean;
  readonly allocateTerminal: boolean;
  readonly title?: string;
  readonly forwardSignal?: (signal: NodeJS.Signals) => Promise<boolean>;
}

export interface SandboxInstanceRemoveOptions {
  readonly force: boolean;
}

export interface SandboxLogQuery {
  readonly tail?: number;
}

export interface SandboxLogFollowRequest extends SandboxLogQuery {
  readonly onOutput: (chunk: Buffer) => void;
  readonly onError: (chunk: Buffer) => void;
}

export interface SandboxLogSubscription extends AsyncDisposable {
  readonly completion: Promise<CommandResult>;
  stop(): Promise<void>;
}

export type CommandResult = ProcessResult;

export interface SandboxRuntimeSelection {
  readonly runtime: SandboxRuntime;
  readonly imageBuilder: SandboxImageBuilder;
  readonly imageOwnershipKey: string;
}
