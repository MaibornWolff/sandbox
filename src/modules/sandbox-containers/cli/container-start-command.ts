import { executeInSandbox } from "../lifecycle/container-execution.js";
import type { SandboxOptions } from "../sandbox-options.js";

/**
 * Start a sandbox container in the foreground (non-detached).
 *
 * Uses the exact same container args as the normal `sandbox` / `sandbox run`
 * flow, but runs `docker run` without `-d` and without `--rm`. All container
 * output (entrypoint logs, firewall init, proxy setup) streams directly to
 * the terminal. Useful for debugging container startup crashes.
 */
export async function containerStartCommand(
  options: SandboxOptions,
): Promise<void> {
  await executeInSandbox(options, {
    command: [],
    stdin: false,
    tty: false,
    foreground: true,
  });
}
