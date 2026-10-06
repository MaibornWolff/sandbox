import type { ProcessResult } from "#platform/process/index.js";

export type ContainerState =
  | "created"
  | "running"
  | "paused"
  | "restarting"
  | "exited"
  | "dead"
  | "unknown";

export interface ContainerQuery {
  readonly all?: boolean;
  readonly labels?: Readonly<Record<string, string | null>>;
  readonly states?: readonly ContainerState[];
}

export interface ContainerSummary {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly imageIdentity: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly state: ContainerState;
}

export interface ContainerDetails extends ContainerSummary {
  readonly startedAt: Date | null;
  readonly mounts: readonly ContainerMount[];
}

export type ContainerMount =
  | {
      readonly type: "bind";
      readonly sourcePath: string;
      readonly targetPath: string;
      readonly readOnly: boolean;
    }
  | {
      readonly type: "volume";
      readonly volumeName: string;
      readonly targetPath: string;
      readonly readOnly: boolean;
    };

export interface PublishedPort {
  readonly hostAddress?: string;
  readonly hostPort: number;
  readonly containerPort: number;
  readonly protocol: "tcp" | "udp";
}

export interface ContainerResources {
  readonly memoryBytes?: number;
  readonly sharedMemorySize?: string;
}

export interface ContainerSecurity {
  readonly capabilities: readonly string[];
  readonly dockerInDocker: boolean;
}

export interface ContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly mounts: readonly ContainerMount[];
  readonly ports: readonly PublishedPort[];
  readonly init: boolean;
  readonly removeOnExit: boolean;
  readonly resources: ContainerResources;
  readonly security: ContainerSecurity;
}

export interface ExecSpec {
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

export type CommandResult = ProcessResult;

export interface RemoveOptions {
  readonly force: boolean;
}

export interface LogQuery {
  readonly tail?: number;
}

export interface LogFollowRequest extends LogQuery {
  readonly onOutput: (chunk: Buffer) => void;
  readonly onError: (chunk: Buffer) => void;
}

export interface LogSubscription extends AsyncDisposable {
  readonly completion: Promise<CommandResult>;
  stop(): Promise<void>;
}

export interface ContainerOperations {
  list(query?: ContainerQuery): Promise<ContainerSummary[]>;
  inspect(id: string): Promise<ContainerDetails | null>;
  startDetached(spec: ContainerSpec): Promise<string>;
  runAttached(
    spec: ContainerSpec,
    session: TerminalSessionOptions,
  ): Promise<CommandResult>;
  signal(id: string, signal: NodeJS.Signals): Promise<void>;
  stopAndRemove(id: string): Promise<void>;
  remove(id: string, options?: RemoveOptions): Promise<void>;
  exec(id: string, spec: ExecSpec): Promise<CommandResult>;
  execAttached(
    id: string,
    spec: ExecSpec,
    session: TerminalSessionOptions,
  ): Promise<CommandResult>;
  readLogs(id: string, query?: LogQuery): Promise<string>;
  followLogs(id: string, request: LogFollowRequest): LogSubscription;
}
