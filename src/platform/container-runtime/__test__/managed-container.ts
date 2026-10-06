import type { ContainerMount } from "../container-contract.js";

export type ManagedContainerStatus =
  | "created"
  | "running"
  | "exited"
  | "removed";

export interface ManagedExecSession {
  readonly pid: string;
  readonly command: string;
}

export interface ManagedContainerValues {
  readonly id?: string;
  readonly name: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly status: Exclude<ManagedContainerStatus, "removed">;
  readonly logs?: string | Error;
  readonly uptime?: string;
  readonly startedAt?: Date;
  readonly mounts?: readonly ContainerMount[];
  readonly readyAfterAttempts?: number;
  readonly sessions?: readonly ManagedExecSession[];
}

export interface ManagedContainerSnapshot {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly status: ManagedContainerStatus;
  readonly logs?: string;
  readonly uptime: string;
  readonly ready: boolean;
  readonly readinessAttempts: number;
  readonly mounts: readonly ContainerMount[];
  readonly sessions: readonly ManagedExecSession[];
}

export interface ManagedContainer {
  readonly id: string;
  givenExecResult(command: readonly string[], result: string | Error): void;
  givenLogs(logs: string | Error): void;
  givenStopsOnReadinessAttempt(attempt: number): void;
  givenSessions(sessions: readonly ManagedExecSession[]): void;
  snapshot(): ManagedContainerSnapshot;
}

interface ExecFixture {
  readonly output?: string;
  readonly error?: Error;
}

export interface ManagedContainerState extends ManagedContainer {
  readonly name: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  status: ManagedContainerStatus;
  logs: string | Error;
  uptime: string;
  readonly startedAt: Date | null;
  resolveExecResult(command: readonly string[]): string;
  waitUntilReady(maxAttempts: number): void;
}

function commandKey(command: readonly string[]): string {
  return JSON.stringify(command);
}

function isReadinessCommand(command: readonly string[]): boolean {
  return command.some((value) => value.includes("/tmp/.sandbox-ready"));
}

function isSessionDetailsCommand(command: readonly string[]): boolean {
  return command.some((part) => part.includes('echo "$pid|$cmd"'));
}

function isIdleCommand(command: readonly string[]): boolean {
  return (
    command.some((part) => part.includes("sandbox-sessions")) &&
    command.some((part) => part.includes('[ -z "$(ls'))
  );
}

function resolveFixture(fixture: ExecFixture): string {
  if (fixture.error) throw fixture.error;
  return fixture.output ?? "";
}

function formatSessions(sessions: readonly ManagedExecSession[]): string {
  return sessions
    .map((session) => `${session.pid}|${session.command}`)
    .join("\n");
}

export function createManagedContainer(
  values: ManagedContainerValues & { readonly id: string },
): ManagedContainerState {
  const execFixtures = new Map<string, ExecFixture>();
  const labels = Object.freeze({ ...values.labels });
  const readyAfterAttempts = values.readyAfterAttempts ?? 0;
  let readinessAttempts = 0;
  let stopOnReadinessAttempt: number | undefined;
  let sessions = [...(values.sessions ?? [])];

  function resolveReadiness(): string {
    readinessAttempts++;
    if (stopOnReadinessAttempt === readinessAttempts) {
      container.status = "exited";
      throw new Error(`Container "${values.id}" is not running.`);
    }
    if (readinessAttempts <= readyAfterAttempts) {
      throw new Error("sandbox readiness marker is not present");
    }
    return "";
  }

  const container: ManagedContainerState = {
    id: values.id,
    name: values.name,
    image: values.image,
    labels,
    status: values.status,
    logs: values.logs ?? "",
    uptime: values.uptime ?? "Up 1 minute",
    startedAt: values.startedAt ?? null,
    givenExecResult(command, result) {
      execFixtures.set(
        commandKey(command),
        result instanceof Error ? { error: result } : { output: result },
      );
    },
    givenLogs(logs) {
      this.logs = logs;
    },
    givenStopsOnReadinessAttempt(attempt) {
      stopOnReadinessAttempt = readinessAttempts + attempt;
    },
    givenSessions(nextSessions) {
      sessions = [...nextSessions];
    },
    waitUntilReady(maxAttempts) {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          resolveReadiness();
          return;
        } catch (error) {
          if (container.status !== "running") throw error;
        }
      }
      throw new Error("sandbox readiness marker was not created in time");
    },
    resolveExecResult(command) {
      const fixture = execFixtures.get(commandKey(command));
      if (fixture) return resolveFixture(fixture);
      if (isReadinessCommand(command)) return resolveReadiness();
      if (isSessionDetailsCommand(command)) return formatSessions(sessions);
      if (command[0] === "/usr/sbin/iptables") return "";
      if (isIdleCommand(command) && sessions.length === 0) return "";
      if (isIdleCommand(command)) throw new Error("exit code 1");
      throw new Error(
        `No exec result configured for container "${values.id}" and command ${JSON.stringify(command)}.`,
      );
    },
    snapshot() {
      return {
        id: values.id,
        name: values.name,
        image: values.image,
        labels,
        status: this.status,
        ...(typeof this.logs === "string" ? { logs: this.logs } : {}),
        uptime: this.uptime,
        ready: readinessAttempts > readyAfterAttempts,
        readinessAttempts,
        mounts: (values.mounts ?? []).map((mount) => ({ ...mount })),
        sessions: sessions.map((session) => ({ ...session })),
      };
    },
  };
  return container;
}
