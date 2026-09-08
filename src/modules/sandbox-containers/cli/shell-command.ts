import { showActiveConfig } from "#modules/configuration/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { getLogger } from "#platform/logging/index.js";
import { executeInSandbox } from "../lifecycle/container-execution.js";
import type { SandboxOptions } from "../sandbox-options.js";

interface ShellOptions extends SandboxOptions {
  verbose?: boolean;
}

/** Run an interactive shell in the sandbox. */
export async function runShell(options: ShellOptions): Promise<void> {
  await executeInSandbox(options, {
    command: ["zsh"],
    stdin: true,
    tty: getHostEnvironment().interactive,
    timingLabel: "Total startup",
    beforeSpawn: (config) => {
      showActiveConfig(config);
      getLogger().info("Starting sandbox shell...");
    },
  });
}
