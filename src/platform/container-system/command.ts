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

function createCommandError(
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
): Promise<string> {
  const result = await getProcessManager().start({
    command,
    args,
    lifetime: "application",
    interaction: { mode: "non-interactive" },
  }).result;
  if (result.exitCode === 0) return result.stdout;
  throw createCommandError(command, result);
}
