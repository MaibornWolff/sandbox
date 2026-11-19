import chalk from "chalk";
import { getConfigurationService } from "#modules/configuration/index.js";
import {
  getRuntimeProvider,
  type RuntimeResolutionRequest,
} from "#platform/container-runtime/index.js";
import { getLogger } from "#platform/logging/index.js";
import { getTerminal } from "#platform/terminal/index.js";

/** @lintignore Presentation state tested by the owning component. */
export interface DockerStatus {
  readonly available: boolean;
  readonly runtime: string | null;
  readonly memoryOk: boolean;
  readonly memoryGB: number | null;
  readonly memoryScope:
    | "per-instance-default"
    | "shared-runtime-vm"
    | "unknown";
}

function loadRuntimeResolution(): RuntimeResolutionRequest | undefined {
  try {
    return getConfigurationService().loadUserRuntimeResolution();
  } catch (error) {
    getLogger().warn(
      `${error instanceof Error ? error.message : String(error)}\nChecking the auto-detected runtime instead.`,
    );
    return undefined;
  }
}

async function checkDockerStatus(): Promise<DockerStatus> {
  const resolution = loadRuntimeResolution();
  try {
    const { runtime } = await getRuntimeProvider().resolve(resolution);
    const hostInfo = await runtime.ensureHostReady();
    const memoryGB =
      hostInfo.memory.bytes === null
        ? null
        : hostInfo.memory.bytes / (1024 * 1024 * 1024);
    return {
      available: true,
      runtime: runtime.runtime,
      memoryOk:
        memoryGB !== null &&
        memoryGB >=
          (hostInfo.memory.scope === "per-instance-default" ? 1.5 : 3.5),
      memoryGB,
      memoryScope: hostInfo.memory.scope,
    };
  } catch {
    return {
      available: false,
      runtime: null,
      memoryOk: false,
      memoryGB: null,
      memoryScope: "unknown",
    };
  }
}

/**
 * Check the runtime that the user config selects.
 * Auto-detects when the config sets no runtime or cannot be read.
 */
export async function displayEnvironmentCheck(): Promise<void> {
  displayEnvironmentStatus(await checkDockerStatus());
}

/** @lintignore Pure owner-local renderer. */
export function renderEnvironmentStatus(status: DockerStatus): string {
  const lines = [chalk.bold("\nEnvironment")];
  if (status.available) {
    lines.push(`  Runtime   ${chalk.green("✓")} Available (${status.runtime})`);
  } else {
    lines.push(
      `  Runtime   ${chalk.red("✗")} Not available`,
      chalk.dim(
        "            Install Docker, Podman, or Apple container to use sandbox",
      ),
    );
  }
  if (status.available && status.memoryGB !== null) {
    const memory = status.memoryGB.toFixed(1);
    const perInstance = status.memoryScope === "per-instance-default";
    const label = perInstance ? "Per-container memory" : "Memory";
    const recommended = perInstance ? 2 : 4;
    lines.push(
      `  ${label.padEnd(9)} ${status.memoryOk ? chalk.green("✓") : chalk.yellow("⚠")} ${memory} GB (recommended: ${recommended}GB+)`,
    );
  }
  return lines.join("\n");
}

function displayEnvironmentStatus(status: DockerStatus): void {
  getTerminal().stdout.write(`${renderEnvironmentStatus(status)}\n`);
}
