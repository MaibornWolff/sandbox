import chalk from "chalk";
import { getTerminal } from "#platform/terminal/index.js";
import {
  type ContainerStatusInfo,
  getSandboxStatus,
  type SandboxStatus,
  type SessionInfo,
} from "../lifecycle/container-status.js";
import type { SandboxOptions } from "../sandbox-options.js";

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

export async function statusCommand(options: SandboxOptions): Promise<void> {
  const status = await getSandboxStatus(options);
  getTerminal().stdout.write(`${renderStatus(status)}\n`);
}
