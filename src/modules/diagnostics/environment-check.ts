import chalk from "chalk";
import { getRuntimeProvider } from "#platform/container-runtime/index.js";
import { checkXHostAccess, detectX11 } from "#platform/environment/index.js";
import { getTerminal } from "#platform/terminal/index.js";

/** @lintignore Presentation state tested by the owning component. */
export interface DockerStatus {
  readonly available: boolean;
  readonly runtime: string | null;
  readonly memoryOk: boolean;
  readonly memoryGB: number | null;
}

/** @lintignore Presentation state tested by the owning component. */
export interface X11Status {
  readonly available: boolean;
  readonly display: string | null;
  readonly xhostConfigured: boolean;
}

/** @lintignore Presentation state tested by the owning component. */
export interface EnvironmentStatus {
  readonly docker: DockerStatus;
  readonly x11: X11Status;
}

async function checkDockerStatus(): Promise<DockerStatus> {
  try {
    const service = await getRuntimeProvider().resolve();
    await service.getVersion();
    let memoryGB: number | null = null;
    try {
      const memory = await service.getMemoryBytes();
      if (memory !== null) memoryGB = memory / (1024 * 1024 * 1024);
    } catch {
      // Memory is optional environment information.
    }
    return {
      available: true,
      runtime: service.runtime,
      memoryOk: memoryGB !== null && memoryGB >= 3.5,
      memoryGB,
    };
  } catch {
    return {
      available: false,
      runtime: null,
      memoryOk: false,
      memoryGB: null,
    };
  }
}

async function checkX11Status(): Promise<X11Status> {
  const [config, access] = await Promise.all([detectX11(), checkXHostAccess()]);
  return {
    available: config.available,
    display: config.display,
    xhostConfigured: access.configured,
  };
}

export async function displayEnvironmentCheck(): Promise<void> {
  displayEnvironmentStatus({
    docker: await checkDockerStatus(),
    x11: await checkX11Status(),
  });
}

/** @lintignore Pure owner-local renderer. */
export function renderEnvironmentStatus(status: EnvironmentStatus): string {
  const lines = [chalk.bold("\nEnvironment")];
  if (status.docker.available) {
    lines.push(
      `  Runtime   ${chalk.green("✓")} Available (${status.docker.runtime})`,
    );
  } else {
    lines.push(
      `  Runtime   ${chalk.red("✗")} Not available`,
      chalk.dim("            Install Docker or Podman to use sandbox"),
    );
  }
  if (status.docker.available && status.docker.memoryGB !== null) {
    const memory = status.docker.memoryGB.toFixed(1);
    if (status.docker.memoryOk) {
      lines.push(
        `  Memory    ${chalk.green("✓")} ${memory} GB (recommended: 4GB+)`,
      );
    } else {
      lines.push(
        `  Memory    ${chalk.yellow("⚠")} ${memory} GB (recommended: 4GB+)`,
        chalk.dim("            Increase memory: colima start --memory 4"),
      );
    }
  }
  if (status.x11.available && status.x11.xhostConfigured) {
    lines.push(
      `  X11       ${chalk.green("✓")} Available (${status.x11.display})`,
    );
  } else if (status.x11.available) {
    lines.push(
      `  X11       ${chalk.yellow("⚠")} Not configured`,
      chalk.dim(
        "            Run 'sandbox setup-x11' to configure clipboard support",
      ),
    );
  } else {
    lines.push(
      `  X11       ${chalk.dim("−")} Not available (optional)`,
      chalk.dim(
        "            Run 'sandbox setup-x11' to configure clipboard support",
      ),
    );
  }
  return lines.join("\n");
}

function displayEnvironmentStatus(status: EnvironmentStatus): void {
  getTerminal().stdout.write(`${renderEnvironmentStatus(status)}\n`);
}
