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
  readonly memoryScope:
    | "per-instance-default"
    | "shared-runtime-vm"
    | "unknown";
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
    const { runtime } = await getRuntimeProvider().resolve();
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
      chalk.dim(
        "            Install Docker, Podman, or Apple container to use sandbox",
      ),
    );
  }
  if (status.docker.available && status.docker.memoryGB !== null) {
    const memory = status.docker.memoryGB.toFixed(1);
    const perInstance = status.docker.memoryScope === "per-instance-default";
    const label = perInstance ? "Per-container memory" : "Memory";
    const recommended = perInstance ? 2 : 4;
    lines.push(
      `  ${label.padEnd(9)} ${status.docker.memoryOk ? chalk.green("✓") : chalk.yellow("⚠")} ${memory} GB (recommended: ${recommended}GB+)`,
    );
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
