import { getClock, waitWithTimeout } from "#platform/clock/index.js";
import { getLogger } from "#platform/logging/index.js";
import { getProcessManager } from "#platform/process/index.js";
import type { SandboxExecProcess } from "./container-contract.js";

export function openContainerExec(
  command: string,
  args: readonly string[],
): SandboxExecProcess {
  const child = getProcessManager().start({
    name: "container exec stream",
    command,
    args,
    lifetime: "application",
    interaction: { mode: "non-interactive" },
    stdio: "stream",
  });
  let disposal: Promise<void> | undefined;
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    completion: child.result,
    [Symbol.asyncDispose]() {
      disposal ??= (async () => {
        await child.stdin
          .end()
          .catch(() =>
            getLogger().warn("Container exec control input could not close."),
          );
        const result = await waitWithTimeout(child.exited, {
          clock: getClock(),
          milliseconds: 5_000,
        });
        if (!result.completed)
          getLogger().warn(
            "Container exec did not stop after control input closed. Stopping the runtime client.",
          );
        await child.dispose();
      })();
      return disposal;
    },
  };
}
