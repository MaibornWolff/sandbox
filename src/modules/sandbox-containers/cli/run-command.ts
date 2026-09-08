import { getHostEnvironment } from "#platform/environment/index.js";
import { executeInSandbox } from "../lifecycle/container-execution.js";
import type { SandboxOptions } from "../sandbox-options.js";

/** Run a single command in sandbox. */
export async function runCommand(
  command: string[],
  options: SandboxOptions,
): Promise<void> {
  await executeInSandbox(options, {
    command,
    stdin: true,
    tty: getHostEnvironment().interactive,
  });
}
