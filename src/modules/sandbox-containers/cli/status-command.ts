import chalk from "chalk";
import type { ContainerSession } from "#platform/container-system/index.js";
import { getTerminal } from "#platform/terminal/index.js";
import { shellQuote } from "#shared/text/index.js";
import {
  type ContainerStatusInfo,
  getContainerUptime,
  getSandboxStatus,
  type SandboxStatus,
  SessionLookupError,
} from "../lifecycle/container-status.js";
import type { StatusOptions } from "../sandbox-options.js";
import { toStatusDocument } from "./status-json.js";

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const SHORT_SESSION_ID_LENGTH = 8;

function renderScope(status: SandboxStatus): string {
  if (status.sessionId !== null) {
    return ` · session ${status.sessionId.slice(0, SHORT_SESSION_ID_LENGTH)}`;
  }
  return status.projectSlug === null ? " · all projects" : "";
}

function renderHeader(status: SandboxStatus): string {
  const lines: string[] = [];
  lines.push(chalk.bold(`⬡ Sandbox Status${renderScope(status)}`));
  lines.push("");
  if (status.projectSlug !== null) {
    lines.push(`  ${chalk.dim("Project")}   ${status.projectSlug}`);
  }
  lines.push(`  ${chalk.dim("Runtime")}   ${status.runtime}`);
  return lines.join("\n");
}

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

function renderProjectHeading(container: ContainerStatusInfo): string {
  const folder = container.projectDir
    ? `  ${chalk.dim(container.projectDir)}`
    : "";
  return `  ${chalk.bold(container.projectSlug)}${folder}`;
}

function renderContainer(container: ContainerStatusInfo): string {
  const lines: string[] = [];

  // Container header: state symbol + name + uptime
  lines.push(
    `  ${renderContainerState(container)} ${chalk.cyan.bold(container.name)}  ${chalk.dim(container.ready === false ? "starting" : getContainerUptime(container.startedAt))}`,
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

  let previous: ContainerStatusInfo | undefined;
  for (const container of status.containers) {
    lines.push("");
    if (
      status.projectSlug === null &&
      container.projectSlug !== previous?.projectSlug
    ) {
      lines.push(renderProjectHeading(container));
    }
    lines.push(renderContainer(container));
    previous = container;
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/** A status failure that `statusCommand` has already printed to stderr. */
class StatusExitError extends Error {
  readonly exitCode = 1;
  readonly reported = true;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  let status: SandboxStatus;
  try {
    status = await getSandboxStatus(options);
  } catch (error) {
    if (!(error instanceof SessionLookupError)) throw error;
    getTerminal().stderr.write(`${error.message}\n`);
    throw new StatusExitError(error.message, { cause: error });
  }
  const output = options.json
    ? JSON.stringify(toStatusDocument(status), null, 2)
    : renderStatus(status);
  getTerminal().stdout.write(`${output}\n`);
}
