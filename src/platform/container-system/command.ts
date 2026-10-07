import { addAbortListener } from "node:events";
import {
  getProcessManager,
  type ProcessResult,
} from "#platform/process/index.js";

class ContainerCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "ContainerCommandError";
  }
}

export function createCommandError(
  command: string,
  result: ProcessResult,
): ContainerCommandError {
  const detail = [result.stderr.trimEnd(), result.stdout.trimEnd()]
    .filter(Boolean)
    .join("\n");
  return new ContainerCommandError(
    result.signal
      ? `${command} terminated by signal ${result.signal}${detail ? `: ${detail}` : ""}`
      : `${command} failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ""}`,
    result.exitCode,
  );
}

export async function executeContainerCommand(
  command: string,
  args: readonly string[] = [],
  options: { readonly signal?: AbortSignal } = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  await using child = getProcessManager().start({
    command,
    args,
    lifetime: "application",
    interaction: { mode: "non-interactive" },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const { signal } = options;
  let rejectCancellation: (reason: unknown) => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  using _cancellation = signal
    ? addAbortListener(signal, () => rejectCancellation(signal.reason))
    : undefined;
  const result = await Promise.race([child.result, cancelled]);
  signal?.throwIfAborted();
  if (result.exitCode === 0) return result.stdout;
  throw createCommandError(command, result);
}
