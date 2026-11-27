import { addAbortListener } from "node:events";
import type { HookConfig, HookEvent } from "#modules/configuration/index.js";
import {
  buildHookCommand,
  HOOK_PULSE,
  readHookResult,
  runHookEvent,
} from "#modules/sandbox-hooks/index.js";
import { getClock } from "#platform/clock/index.js";
import type {
  SandboxExecSpec,
  SandboxInstanceOperations,
} from "#platform/container-runtime/index.js";
import { getLogger } from "#platform/logging/index.js";
import { getProcessManager } from "#platform/process/index.js";
import { createControlWatchdog, readControlLines } from "./control-watchdog.js";

async function launchSessionHook(options: {
  readonly containers: SandboxInstanceOperations;
  readonly containerId: string;
  readonly spec: SandboxExecSpec;
  readonly hook: HookConfig;
  readonly signal?: AbortSignal;
}): Promise<string | undefined> {
  const { containers, containerId, spec, hook, signal } = options;
  await using control = await containers.openExec(
    containerId,
    { ...spec, user: "sandbox", command: buildHookCommand(hook, true) },
    hook.event === "session.end" ? { finalization: true } : undefined,
  );
  using watchdog = createControlWatchdog(5_000, signal);
  let result = "";
  const output = readControlLines(control.stdout, (line) => {
    if (line === HOOK_PULSE) watchdog.pulse();
    else result = result ? "invalid" : line;
  });
  const diagnostics = (async () => {
    for await (const _ of control.stderr) {
      /* Discard launcher diagnostics. */
    }
  })();
  return await Promise.race([
    Promise.all([control.completion, output, diagnostics]).then(([status]) =>
      status.exitCode === 0
        ? readHookResult(result)
        : "could not reach the guest launcher",
    ),
    watchdog.expired.then(() => "lost contact with the guest launcher"),
  ]);
}

export async function runSessionHooks(options: {
  readonly containers: SandboxInstanceOperations;
  readonly containerId: string;
  readonly spec: SandboxExecSpec;
  readonly hooks: readonly HookConfig[];
  readonly event: Extract<HookEvent, `session.${string}`>;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const run = (signal?: AbortSignal) =>
    runHookEvent({
      ...options,
      signal,
      launch: (hook) => launchSessionHook({ ...options, hook, signal }),
      warn: (message) => getLogger().warn(message),
    });
  if (options.event === "session.start") {
    await run(options.signal);
    return;
  }

  const forced = getProcessManager().forcedTermination;
  const clock = getClock();
  const deadline = new AbortController();
  const cancellation = new AbortController();
  const startDeadline = () => {
    void clock.sleep(5_000, { signal: deadline.signal }).then(
      () =>
        cancellation.abort(
          new Error("Session end hooks timed out during forced shutdown."),
        ),
      () => undefined,
    );
  };
  using _forcedListener = forced.aborted
    ? undefined
    : addAbortListener(forced, startDeadline);
  if (forced.aborted) startDeadline();
  try {
    await run(
      options.signal
        ? AbortSignal.any([options.signal, cancellation.signal])
        : cancellation.signal,
    );
  } finally {
    deadline.abort();
  }
}
