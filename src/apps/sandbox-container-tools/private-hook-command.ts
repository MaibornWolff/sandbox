import {
  HOOK_BOOT_ENV,
  HOOK_COMMAND,
  HOOK_PULSE,
  HOOK_SUPERVISOR,
  parseGuestHook,
} from "#modules/sandbox-hooks/index.js";
import { runIsolatedGuestCommand } from "#platform/process/index.js";

export async function runPrivateHookCommand(
  args: readonly string[],
  output: NodeJS.WritableStream,
): Promise<number | undefined> {
  const [verb, mode, serialized, ...rest] = args;
  if (verb !== HOOK_COMMAND && verb !== HOOK_SUPERVISOR) return undefined;
  const supervising = verb === HOOK_SUPERVISOR;
  if (!serialized || rest.length > 0 || (mode !== "lease" && mode !== "once"))
    return 1;
  try {
    const hook = parseGuestHook(serialized);
    const result = await runIsolatedGuestCommand({
      command: hook.command,
      environment: {
        SANDBOX_EVENT: hook.event,
        [HOOK_BOOT_ENV]: undefined,
        ...(hook.event.startsWith("container.")
          ? { SANDBOX_SESSION_ID: undefined }
          : {}),
      },
      timeoutMs: hook.timeoutMs,
      supervising,
      supervisorArgs:
        !supervising && !hook.wait
          ? [HOOK_SUPERVISOR, "once", serialized]
          : undefined,
      leasePulse: mode === "lease" && !supervising ? HOOK_PULSE : undefined,
    });
    if (!supervising) output.write(`${result}\n`);
    return 0;
  } catch {
    if (!supervising) output.write("spawn\n");
    return 0;
  }
}
