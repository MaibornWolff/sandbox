import type { SandboxRuntime } from "#platform/container-runtime/index.js";
import { getLogger } from "#platform/logging/index.js";
import { getTerminal } from "#platform/terminal/index.js";

/**
 * Returns true when the error message contains "no space left on device".
 * @testonly
 */
export function isNoSpaceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  return getErrorSearchText(err).includes("no space left on device");
}

function getErrorSearchText(err: Error): string {
  const parts = [err.message];

  if ("stderr" in err && typeof err.stderr === "string") {
    parts.push(err.stderr);
  }
  if ("stdout" in err && typeof err.stdout === "string") {
    parts.push(err.stdout);
  }

  return parts.join("\n").toLowerCase();
}

/**
 * If err is a "no space left on device" error, prints a highlighted warning
 * explaining what happened and how to free space. Does nothing otherwise.
 */
export function warnIfNoSpaceError(
  err: unknown,
  service: SandboxRuntime,
): void {
  if (!isNoSpaceError(err)) return;

  getLogger().warn("No space left on device - build cache is likely full.");

  const hint = service.getDiskSpaceAdvice();
  getTerminal().stderr.write(
    `\n  To free space, run one of the following:\n\n  ${hint}\n\n`,
  );
}
