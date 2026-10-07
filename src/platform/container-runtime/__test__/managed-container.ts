import type {
  ContainerDetails,
  ContainerMount,
} from "../container-contract.js";

export type ManagedContainerStatus = ContainerDetails["state"] | "removed";

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
  readonly controls: readonly string[];
}

export interface ManagedContainer {
  readonly id: string;
  givenExecResult(command: readonly string[], result: string | Error): void;
  givenLogs(logs: string | Error): void;
  givenStopsOnReadinessAttempt(attempt: number): void;
  givenSessions(sessions: readonly ManagedExecSession[]): void;
  givenControls(pids: readonly string[]): void;
  givenStatus(status: Exclude<ManagedContainerStatus, "removed">): void;
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
    command.some((part) => part.includes("&& exit 1"))
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
  let controls: string[] = [];

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

  function resolveReadinessScript(command: readonly string[]): string {
    const script =
      command[0] === "sh" && command[1] === "-c" ? command[2] : undefined;
    const attempts = script?.match(/\[ "\$i" -ge (\d+) \]/u)?.[1];
    if (!attempts) return resolveReadiness();
    container.waitUntilReady(Number(attempts));
    const output =
      command.length > 4 ? container.resolveExecResult(command.slice(4)) : "";
    const message = script?.match(/printf '%s\\n' '([^']*)'/u)?.[1] ?? "";
    return `${message}\n${output}`;
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
    givenControls(pids) {
      controls = [...pids];
    },
    givenStatus(status) {
      this.status = status;
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
      if (isReadinessCommand(command)) return resolveReadinessScript(command);
      if (isSessionDetailsCommand(command)) return formatSessions(sessions);
      if (command[0] === "/usr/sbin/iptables") return "";
      if (command.some((part) => part.includes("/usr/sbin/iptables-save")))
        return "";
      if (
        isIdleCommand(command) &&
        sessions.length === 0 &&
        controls.length === 0
      )
        return "";
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
        controls: [...controls],
      };
    },
  };
  return container;
}
