import chalk from "chalk";
import {
  getRuntimeProvider,
  type RuntimeResolutionRequest,
} from "#platform/container-runtime/index.js";
import { getTerminal } from "#platform/terminal/index.js";

interface DockerCheckResult {
  readonly available: boolean;
  readonly runtime: string | null;
  readonly version: string | null;
  readonly memoryGB: number | null;
  readonly memoryOk: boolean;
  readonly memoryScope:
    | "per-instance-default"
    | "shared-runtime-vm"
    | "unknown";
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

const RECOMMENDED_MEMORY_GB = 4;

function parseVersion(output: string): string | null {
  return output.match(/version\s+(\d+\.\d+\.\d+)/i)?.[1] ?? null;
}

export async function checkDocker(
  runtimeResolution?: RuntimeResolutionRequest,
): Promise<DockerCheckResult> {
  const result: {
    available: boolean;
    runtime: string | null;
    version: string | null;
    memoryGB: number | null;
    memoryOk: boolean;
    memoryScope: "per-instance-default" | "shared-runtime-vm" | "unknown";
    errors: string[];
    warnings: string[];
  } = {
    available: false,
    runtime: null,
    version: null,
    memoryGB: null,
    memoryOk: false,
    memoryScope: "unknown",
    errors: [],
    warnings: [],
  };
  try {
    const { runtime } = await getRuntimeProvider().resolve(runtimeResolution);
    const hostInfo = await runtime.ensureHostReady();
    result.version = parseVersion(hostInfo.version);
    result.available = true;
    result.runtime = runtime.runtime;
    result.memoryScope = hostInfo.memory.scope;
    if (hostInfo.memory.bytes !== null) {
      result.memoryGB = hostInfo.memory.bytes / (1024 * 1024 * 1024);
      const recommendedMemoryGB =
        hostInfo.memory.scope === "per-instance-default"
          ? 2
          : RECOMMENDED_MEMORY_GB;
      result.memoryOk = result.memoryGB >= recommendedMemoryGB - 0.5;
      if (!result.memoryOk) {
        result.warnings.push(
          `Memory ${result.memoryGB.toFixed(1)}GB is below recommended ${recommendedMemoryGB}GB`,
        );
      }
    } else {
      result.warnings.push("Could not check runtime memory limit");
    }
  } catch (error) {
    result.errors.push(
      error instanceof Error
        ? error.message
        : "No container runtime found. Install Docker, Podman, or Apple container.",
    );
  }
  return result;
}

function renderDockerStatus(result: DockerCheckResult): string {
  const lines = [chalk.bold("Container Runtime")];
  if (result.available) {
    const version = result.version ? ` ${result.version}` : "";
    lines.push(`  ${chalk.green("✓")} ${result.runtime}${version} detected`);
    if (result.memoryGB !== null) {
      const memory = result.memoryGB.toFixed(1);
      const perInstance = result.memoryScope === "per-instance-default";
      const recommended = perInstance ? 2 : RECOMMENDED_MEMORY_GB;
      const label = perInstance ? "Per-container memory" : "Memory limit";
      lines.push(
        `  ${result.memoryOk ? chalk.green("✓") : chalk.yellow("⚠")} ${label}: ${memory}GB (recommended: ${recommended}GB+)`,
      );
    }
  } else {
    lines.push(
      `  ${chalk.red("✗")} Not available`,
      ...result.errors.flatMap((error) =>
        error.split("\n").map((line) => chalk.dim(`    → ${line}`)),
      ),
      chalk.dim("    → Install Docker, Podman, or Apple container"),
    );
  }
  return lines.join("\n");
}

export function displayDockerStatus(result: DockerCheckResult): void {
  getTerminal().stdout.write(`${renderDockerStatus(result)}\n`);
}
