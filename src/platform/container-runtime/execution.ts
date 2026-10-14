import { ExecError } from "#platform/process/index.js";
import type { CommandResult } from "./container-contract.js";
import type { RuntimeExecOptions, RuntimeExecutor } from "./executor.js";

export async function executeRuntimeCommand(
  exec: RuntimeExecutor,
  command: string,
  args: readonly string[],
  options?: RuntimeExecOptions,
): Promise<CommandResult> {
  try {
    return {
      exitCode: 0,
      stdout: await exec(command, args, options),
      stderr: "",
    };
  } catch (error) {
    if (!(error instanceof ExecError)) throw error;
    return {
      exitCode: error.exitCode,
      stdout: error.stdout,
      stderr: error.stderr,
    };
  }
}
