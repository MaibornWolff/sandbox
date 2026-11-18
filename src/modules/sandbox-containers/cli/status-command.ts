import chalk from "chalk";
import type { ContainerSession } from "#platform/container-system/index.js";
import { getTerminal } from "#platform/terminal/index.js";
import { shellQuote } from "#shared/text/index.js";
import {
  type ContainerStatusInfo,
  getSandboxStatus,
  type SandboxStatus,
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

const SHORT_SESSION_ID_LENGTH = 8;

function formatSessionCommand(session: ContainerSession): string {
  if (session.command?.length) return session.command.map(shellQuote).join(" ");
  return session.title || "unknown";
}

function renderSession(session: ContainerSession): string {
  const parts = [formatSessionCommand(session)];
  if (session.id) {
    parts.push(chalk.cyan(session.id.slice(0, SHORT_SESSION_ID_LENGTH)));
  }
  parts.push(chalk.dim(`(PID ${session.pid})`));
  return parts.join("  ");
}

function renderSessions(
  sessions: readonly ContainerSession[] | null,
): string[] {
  const lines: string[] = [];
  if (sessions === null) {
    lines.push(`    ${chalk.dim("Sessions")}  ${chalk.dim("unknown")}`);
    return lines;
  }
  if (sessions.length === 0) {
    lines.push(`    ${chalk.dim("Sessions")}  ${chalk.dim("none")}`);
    return lines;
  }

  lines.push(`    ${chalk.dim("Sessions")}  ${sessions.length} active`);

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i] as ContainerSession;
    const isLast = i === sessions.length - 1;
    const branch = isLast ? "└" : "├";
    lines.push(`              ${chalk.dim(branch)} ${renderSession(session)}`);
  }

  return lines;
}

function renderContainerState(container: ContainerStatusInfo): string {
  if (container.ready === null) return chalk.dim("○");
  return container.ready ? chalk.green("●") : chalk.yellow("◐");
}

function renderContainer(container: ContainerStatusInfo): string {
  const lines: string[] = [];

  // Container header: state symbol + name + uptime
  lines.push(
    `  ${renderContainerState(container)} ${chalk.cyan.bold(container.name)}  ${chalk.dim(container.ready === false ? "starting" : container.uptime)}`,
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
