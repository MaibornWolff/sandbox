import { getClock, waitWithTimeout } from "#platform/clock/index.js";
import { getLogger } from "#platform/logging/index.js";
import { getProcessManager } from "#platform/process/index.js";
import type {
  ContainerExecOptions,
  SandboxExecProcess,
} from "./container-contract.js";

export function openContainerExec(
  command: string,
  args: readonly string[],
  options?: ContainerExecOptions,
): SandboxExecProcess {
  const streams = new AbortController();
  const child = getProcessManager().start({
    name: "container exec stream",
    command,
    args,
    lifetime: "application",
    interaction: { mode: "non-interactive" },
    stdio: "stream",
    finalization: options?.finalization,
    signal: streams.signal,
  });
  let disposal: Promise<void> | undefined;
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    completion: child.result,
    [Symbol.asyncDispose]() {
      disposal ??= (async () => {
        const result = await waitWithTimeout(
          Promise.all([
            child.stdin
              .end()
              .catch(() =>
                getLogger().warn(
                  "Container exec control input could not close.",
                ),
              ),
            child.exited,
          ]),
          { clock: getClock(), milliseconds: 5_000 },
        );
        if (result.completed) {
          await child.dispose();
          return;
        }
        getLogger().warn(
          "Container exec did not stop after control input closed. Stopping the runtime client.",
        );
        try {
          await child.dispose();
        } finally {
          streams.abort();
        }
      })();
      return disposal;
    },
  };
}
