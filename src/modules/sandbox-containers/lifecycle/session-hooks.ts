import type { HookConfig, HookEvent } from "#modules/configuration/index.js";
import {
  buildHookCommand,
  HOOK_PULSE,
  readHookResult,
  runHookEvent,
} from "#modules/sandbox-hooks/index.js";
import type {
  SandboxExecSpec,
  SandboxInstanceOperations,
} from "#platform/container-runtime/index.js";
import { getLogger } from "#platform/logging/index.js";
import { createControlWatchdog, readControlLines } from "./control-watchdog.js";

async function launchSessionHook(options: {
  readonly containers: SandboxInstanceOperations;
  readonly containerId: string;
  readonly spec: SandboxExecSpec;
  readonly hook: HookConfig;
  readonly signal?: AbortSignal;
}): Promise<string | undefined> {
  const { containers, containerId, spec, hook, signal } = options;
  await using control = await containers.openExec(containerId, {
    ...spec,
    user: "sandbox",
    command: buildHookCommand(hook, true),
  });
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
  await runHookEvent({
    ...options,
    launch: (hook) => launchSessionHook({ ...options, hook }),
    warn: (message) => getLogger().warn(message),
  });
}
