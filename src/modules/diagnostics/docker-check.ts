import chalk from "chalk";
import { getRuntimeProvider } from "#platform/container-runtime/index.js";
import { getTerminal } from "#platform/terminal/index.js";

interface DockerCheckResult {
  readonly available: boolean;
  readonly runtime: string | null;
  readonly version: string | null;
  readonly memoryGB: number | null;
  readonly memoryOk: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

const RECOMMENDED_MEMORY_GB = 4;

function parseVersion(output: string): string | null {
  return output.match(/version\s+(\d+\.\d+\.\d+)/i)?.[1] ?? null;
}

export async function checkDocker(
  configuredRuntime?: string,
): Promise<DockerCheckResult> {
  const result: {
    available: boolean;
    runtime: string | null;
    version: string | null;
    memoryGB: number | null;
    memoryOk: boolean;
    errors: string[];
    warnings: string[];
  } = {
    available: false,
    runtime: null,
    version: null,
    memoryGB: null,
    memoryOk: false,
    errors: [],
    warnings: [],
  };
  try {
    const service = await getRuntimeProvider().resolve(configuredRuntime);
    result.version = parseVersion(await service.getVersion());
    result.available = true;
    result.runtime = service.runtime;
    try {
      const memory = await service.getMemoryBytes();
      if (memory !== null) {
        result.memoryGB = memory / (1024 * 1024 * 1024);
        result.memoryOk = result.memoryGB >= RECOMMENDED_MEMORY_GB - 0.5;
        if (!result.memoryOk) {
          result.warnings.push(
            `Memory ${result.memoryGB.toFixed(1)}GB is below recommended ${RECOMMENDED_MEMORY_GB}GB`,
          );
        }
      }
    } catch {
      result.warnings.push("Could not check runtime memory limit");
    }
  } catch {
    result.errors.push("No container runtime found. Install Docker or Podman.");
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
      if (result.memoryOk) {
        lines.push(
          `  ${chalk.green("✓")} Memory limit: ${memory}GB (recommended: ${RECOMMENDED_MEMORY_GB}GB+)`,
        );
      } else {
        lines.push(
          `  ${chalk.yellow("⚠")} Memory limit: ${memory}GB (recommended: ${RECOMMENDED_MEMORY_GB}GB+)`,
          chalk.dim("    → Increase memory: colima start --memory 4"),
        );
      }
    }
  } else {
    lines.push(
      `  ${chalk.red("✗")} Not available`,
      chalk.dim("    → Install Docker or Podman to use sandbox"),
    );
  }
  return lines.join("\n");
}

export function displayDockerStatus(result: DockerCheckResult): void {
  getTerminal().stdout.write(`${renderDockerStatus(result)}\n`);
}
