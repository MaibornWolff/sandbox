import { fork, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setInterval, setTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    )
      return false;
    throw error;
  }
}

function atDeadline(milliseconds: number, expire: () => void): () => void {
  const started = performance.now();
  let timer: NodeJS.Timeout;
  function schedule(): void {
    const remaining = milliseconds - (performance.now() - started);
    if (remaining <= 0) expire();
    else
      timer = setTimeout(
        schedule,
        Math.min(Math.ceil(remaining), 2_147_483_647),
      );
  }
  schedule();
  return () => clearTimeout(timer);
}

async function runGroup(options: {
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly signal: AbortSignal;
  readonly acknowledge?: (result: string) => void;
}): Promise<string> {
  const [executable, ...args] = options.command;
  if (!executable || options.signal.aborted) return "spawn";
  const child = spawn(executable, args, {
    env: options.environment,
    detached: true,
    stdio: "ignore",
  });
  const outcome = new Promise<string>((resolve) => {
    child.once("spawn", () => options.acknowledge?.("ok"));
    child.once("error", () => {
      options.acknowledge?.("spawn");
      resolve("spawn");
    });
    child.once("exit", (code, signal) =>
      resolve(signal ? `signal:${signal}` : code === 0 ? "ok" : `exit:${code}`),
    );
  });
  let stop: Promise<void> | undefined;
  let reason: string | undefined;
  const terminate = (result: string): void => {
    const pid = child.pid;
    if (reason !== undefined || pid === undefined) return;
    reason = result;
    stop = (async () => {
      if (!signalGroup(pid, "SIGTERM")) return;
      // The group can still contain children after its leader exits.
      await sleep(250);
      signalGroup(pid, "SIGKILL");
    })();
    void stop.catch(() => undefined);
  };
  const abort = () => terminate("cancelled");
  options.signal.addEventListener("abort", abort, { once: true });
  const cancelDeadline =
    options.timeoutMs === undefined
      ? undefined
      : atDeadline(options.timeoutMs, () => terminate("timeout"));
  try {
    const result = await outcome;
    await stop;
    return reason ?? result;
  } finally {
    cancelDeadline?.();
    options.signal.removeEventListener("abort", abort);
  }
}

async function startSupervisor(
  args: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  const entry = process.argv[1];
  if (!entry || signal.aborted) return "spawn";
  const supervisor = fork(entry, [...args], {
    detached: true,
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish("spawn"), 3_000);
    const abort = () => finish("spawn");
    let finished = false;
    const finish = (result: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (supervisor.connected) supervisor.disconnect();
      if (result !== "ok") supervisor.kill("SIGTERM");
      supervisor.unref();
      resolve(result);
    };
    signal.addEventListener("abort", abort, { once: true });
    supervisor.once("message", (message: unknown) =>
      finish(message === "ok" ? "ok" : "spawn"),
    );
    supervisor.once("error", () => finish("spawn"));
    supervisor.once("exit", () => finish("spawn"));
  });
}

export async function runIsolatedGuestCommand(options: {
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly supervisorArgs?: readonly string[];
  readonly supervising?: boolean;
  readonly leasePulse?: string;
}): Promise<string> {
  if (!process.getuid || process.getuid() === 0) return "spawn";
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  let acknowledged = false;
  const onDisconnect = () => {
    if (!acknowledged) cancel();
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, cancel);
  const pulse = () => process.stdout.write(`${options.leasePulse}\n`);
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    if (options.supervising) {
      if (!process.send || !process.connected) return "spawn";
      process.once("disconnect", onDisconnect);
    }
    if (options.leasePulse !== undefined) {
      process.stdin.once("end", cancel);
      process.stdin.once("error", cancel);
      process.stdout.once("error", cancel);
      process.stdin.resume();
      pulse();
      heartbeat = setInterval(pulse, 1_000);
    }
    if (options.supervisorArgs)
      return await startSupervisor(options.supervisorArgs, cancellation.signal);
    return await runGroup({
      command: options.command,
      environment: { ...process.env, ...options.environment },
      timeoutMs: options.timeoutMs,
      signal: cancellation.signal,
      ...(options.supervising
        ? {
            acknowledge: (result: string) => {
              if (!process.connected) return;
              process.send?.(result, (error) => {
                if (error) cancel();
              });
              acknowledged = true;
            },
          }
        : {}),
    });
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
      process.stdin.off("end", cancel);
      process.stdin.off("error", cancel);
      process.stdout.off("error", cancel);
      process.stdin.pause();
    }
    process.off("disconnect", onDisconnect);
    if (options.supervising && process.connected) process.disconnect?.();
    for (const signal of signals) process.off(signal, cancel);
  }
}
