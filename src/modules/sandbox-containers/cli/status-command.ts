import chalk from "chalk";
import type { SandboxInstanceResourceUsage } from "#platform/container-runtime/index.js";
import { getTerminal } from "#platform/terminal/index.js";
import {
  type ContainerStatusInfo,
  getSandboxStatus,
  type SandboxStatus,
  type SessionInfo,
} from "../lifecycle/container-status.js";
import type { StatusOptions } from "../sandbox-options.js";

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderHeader(status: SandboxStatus): string {
  const lines: string[] = [];
  lines.push(chalk.bold("⬡ Sandbox Status"));
  lines.push("");
  lines.push(`  ${chalk.dim("Project")}   ${status.projectSlug}`);
  lines.push(`  ${chalk.dim("Runtime")}   ${status.runtime}`);
  return lines.join("\n");
}

function renderSessions(sessions: SessionInfo[]): string[] {
  const lines: string[] = [];
  if (sessions.length === 0) {
    lines.push(`    ${chalk.dim("Sessions")}  ${chalk.dim("none")}`);
    return lines;
  }

  lines.push(`    ${chalk.dim("Sessions")}  ${sessions.length} active`);

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i] as SessionInfo;
    const isLast = i === sessions.length - 1;
    const branch = isLast ? "└" : "├";
    lines.push(
      `              ${chalk.dim(branch)} ${session.command} ${chalk.dim(`(PID ${session.pid})`)}`,
    );
  }

  return lines;
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

function formatBytes(bytes: number): string {
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1_024;
    unitIndex++;
  }
  const digits = unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unitIndex]}`;
}

function renderResources(
  resources: SandboxInstanceResourceUsage | null,
): string {
  if (!resources) {
    return `    ${chalk.dim("Resources")} ${chalk.dim("unavailable")}`;
  }
  const memory = resources.memoryLimitBytes
    ? `${formatBytes(resources.memoryUsageBytes)} / ${formatBytes(resources.memoryLimitBytes)}`
    : formatBytes(resources.memoryUsageBytes);
  return `    ${chalk.dim("Resources")} CPU ${resources.cpuPercent.toFixed(1)}%  Memory ${memory}  PIDs ${resources.processCount}`;
}

function renderContainer(container: ContainerStatusInfo): string {
  const lines: string[] = [];

  // Container header: green dot + name + uptime
  lines.push(
    `  ${chalk.green("●")} ${chalk.cyan.bold(container.name)}  ${chalk.dim(container.uptime)}`,
  );

  // Image
  lines.push(`    ${chalk.dim("Image")}     ${container.image}`);

  // Config hash
  if (container.hash) {
    lines.push(`    ${chalk.dim("Hash")}      ${chalk.dim(container.hash)}`);
  }

  lines.push(renderResources(container.resources));

  // Sessions
  lines.push(...renderSessions(container.sessions));

  return lines.join("\n");
}

function renderStatus(status: SandboxStatus): string {
  const lines: string[] = [];

  lines.push(renderHeader(status));

  if (status.containers.length === 0) {
    lines.push("");
    lines.push(`  ${chalk.dim("No active containers.")}`);
    lines.push("");
    return lines.join("\n");
  }

  for (const container of status.containers) {
    lines.push("");
    lines.push(renderContainer(container));
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function statusCommand(options: StatusOptions): Promise<void> {
  const status = await getSandboxStatus(options);
  const output = options.json
    ? JSON.stringify(status, null, 2)
    : renderStatus(status);
  getTerminal().stdout.write(`${output}\n`);
}
