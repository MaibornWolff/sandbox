import { getProcessManager } from "#platform/process/index.js";
import { getTerminal } from "./terminal.js";

/** Launch a coding agent attached to the current terminal. */
export async function launchInteractiveAgent(
  command: string,
  args: readonly string[],
): Promise<number> {
  const child = getProcessManager().start({
    command,
    args,
    lifetime: "application",
    interaction: { mode: "interactive" },
    stdio: "inherit",
    signal: getTerminal().signal,
  });
  return (await child.result).exitCode;
}
