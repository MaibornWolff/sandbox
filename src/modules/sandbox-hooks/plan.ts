import { posix } from "node:path";
import type { HookConfig, HookEvent } from "#modules/configuration/index.js";

export const HOOK_BOOT_ENV = "SANDBOX_HOOK_BOOT";
export const HOOK_TOOLS_PATH = "/usr/local/bin/sandbox-container-tools";
export const HOOK_COMMAND = "__run-hook";
export const HOOK_SUPERVISOR = "__supervise-hook";
export const HOOK_PULSE = "sandbox-hook-running";

interface ContainerHookPlan {
  readonly projectRoot: string;
  readonly hooks: readonly HookConfig[];
}

function argument(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(serialized: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch {
    throw new Error("Invalid lifecycle hook payload.");
  }
}

function parseHook(value: unknown): HookConfig {
  if (!record(value)) throw new Error("Invalid lifecycle hook descriptor.");
  const { event, command, wait, timeoutMs, onError } = value;
  const start = event === "container.start" || event === "session.start";
  if (
    (!start && event !== "container.stop" && event !== "session.end") ||
    !Array.isArray(command) ||
    !command.every(argument) ||
    !command[0] ||
    typeof wait !== "boolean" ||
    (timeoutMs !== undefined &&
      (typeof timeoutMs !== "number" ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0)) ||
    (start ? onError !== "fail" && onError !== "warn" : onError !== undefined)
  )
    throw new Error("Invalid lifecycle hook descriptor.");
  return {
    event,
    command,
    wait,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(start
      ? { onError: onError === "warn" ? ("warn" as const) : ("fail" as const) }
      : {}),
  };
}

function isContainerHook(hook: HookConfig): boolean {
  return hook.event === "container.start" || hook.event === "container.stop";
}

function canonicalHook(hook: HookConfig): HookConfig {
  return {
    event: hook.event,
    command: hook.command,
    wait: hook.wait,
    ...(hook.timeoutMs === undefined ? {} : { timeoutMs: hook.timeoutMs }),
    ...(hook.event.endsWith(".start")
      ? { onError: hook.onError ?? "fail" }
      : {}),
  };
}

export function serializeBootHooks(
  hooks: readonly HookConfig[],
  projectRoot: string,
): string | undefined {
  const plan = hooks.filter(isContainerHook).map(canonicalHook);
  return plan.length === 0
    ? undefined
    : JSON.stringify({ version: 1, projectRoot, hooks: plan });
}

export function parseBootHooks(
  serialized: string | undefined,
): ContainerHookPlan | undefined {
  if (serialized === undefined) return undefined;
  const payload = parsePayload(serialized);
  if (
    !record(payload) ||
    payload.version !== 1 ||
    !argument(payload.projectRoot) ||
    !posix.isAbsolute(payload.projectRoot) ||
    !Array.isArray(payload.hooks)
  ) {
    throw new Error("Invalid container lifecycle hook plan.");
  }
  const hooks = payload.hooks.map(parseHook);
  if (!hooks.every(isContainerHook))
    throw new Error("Invalid container lifecycle hook event.");
  return { projectRoot: payload.projectRoot, hooks };
}

export function parseGuestHook(serialized: string): HookConfig {
  return parseHook(parsePayload(serialized));
}

export function buildHookCommand(
  hook: HookConfig,
  lease: boolean,
): readonly string[] {
  return [
    HOOK_TOOLS_PATH,
    HOOK_COMMAND,
    lease ? "lease" : "once",
    JSON.stringify(canonicalHook(hook)),
  ];
}

export async function runHookEvent(options: {
  readonly hooks: readonly HookConfig[];
  readonly event: HookEvent;
  readonly launch: (hook: HookConfig) => Promise<string | undefined>;
  readonly warn: (message: string) => void;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const { hooks, event, launch, warn, signal } = options;
  let index = 0;
  for (const hook of hooks) {
    if (hook.event !== event) continue;
    index += 1;
    signal?.throwIfAborted();
    const failure = await launch(hook).catch(
      () => "could not reach the guest launcher",
    );
    signal?.throwIfAborted();
    if (!hook.wait || failure === undefined) continue;
    const message = `Lifecycle hook ${event} #${index} ${failure}.`;
    if (event.endsWith(".start") && hook.onError !== "warn")
      throw new Error(message);
    warn(message);
  }
}

export function readHookResult(result: string): string | undefined {
  if (result === "ok") return undefined;
  if (result === "spawn") return "could not start its command";
  if (result === "timeout") return "timed out";
  if (result === "cancelled") return "was cancelled";
  if (/^exit:\d+$/u.test(result)) return `exited with code ${result.slice(5)}`;
  if (/^signal:SIG[A-Z0-9]+$/u.test(result))
    return `exited with signal ${result.slice(7)}`;
  return "did not return a guest result";
}
