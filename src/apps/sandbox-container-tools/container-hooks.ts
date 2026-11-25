import type { HookConfig } from "#modules/configuration/index.js";
import {
  buildHookCommand,
  readHookResult,
  runHookEvent,
} from "#modules/sandbox-hooks/index.js";
import { getLogger } from "#platform/logging/index.js";
import { getProcessManager } from "#platform/process/index.js";

export async function runContainerHooks(options: {
  readonly plan: {
    readonly hooks: readonly HookConfig[];
    readonly projectRoot: string;
  };
  readonly event: "container.start" | "container.stop";
  readonly signal?: AbortSignal;
}): Promise<void> {
  const { plan, event, signal } = options;
  const processes = getProcessManager();
  await runHookEvent({
    hooks: plan.hooks,
    event,
    ...(signal ? { signal } : {}),
    warn: (message) => getLogger().warn(message),
    launch: async (hook) => {
      await using launcher = processes.start({
        command: "/usr/sbin/gosu",
        args: ["sandbox", ...buildHookCommand(hook, false)],
        cwd: plan.projectRoot,
        lifetime: "application",
        interaction: { mode: "non-interactive" },
        ...(signal ? { signal } : {}),
      });
      const result = await launcher.result;
      return result.exitCode === 0
        ? readHookResult(result.stdout.trim())
        : "could not reach the guest launcher";
    },
  });
}
