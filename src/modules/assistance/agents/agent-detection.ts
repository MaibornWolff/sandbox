import * as path from "node:path";
import { getHostEnvironment } from "#platform/environment/index.js";
import { isExecutableFile } from "#platform/filesystem/index.js";
import { getSupportedAssistAgents } from "./agent-catalog.js";
import type { AgentInfo } from "./agent-definition.js";

const AGENT_PRIORITY: AgentInfo[] = getSupportedAssistAgents();

function getExecutableExtensions(
  operatingSystem: NodeJS.Platform,
  variables: Readonly<Record<string, string>>,
): string[] {
  if (operatingSystem !== "win32") return [""];

  const pathExt = variables.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  return pathExt
    .split(";")
    .filter(Boolean)
    .map((ext) => ext.toLowerCase());
}

/** Check if a command exists on PATH without executing it. */
function commandExists(cmd: string): boolean {
  const environment = getHostEnvironment();
  const operatingSystem = environment.platform;
  const hasPathSeparator = cmd.includes("/") || cmd.includes("\\");

  if (hasPathSeparator || path.isAbsolute(cmd)) {
    return isExecutableFile(cmd, operatingSystem);
  }

  const delimiter = operatingSystem === "win32" ? ";" : ":";
  const pathEntries = (environment.variables.PATH ?? "")
    .split(delimiter)
    .filter(Boolean);
  const hasExtension = path.extname(cmd) !== "";
  const executableExtensions = hasExtension
    ? [""]
    : getExecutableExtensions(operatingSystem, environment.variables);

  for (const entry of pathEntries) {
    for (const extension of executableExtensions) {
      if (
        isExecutableFile(
          path.join(entry, `${cmd}${extension}`),
          operatingSystem,
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

/** Detect the first available AI agent, or null if none found. @testonly */
export function detectAgent(): AgentInfo | null {
  for (const agent of AGENT_PRIORITY) {
    if (commandExists(agent.command)) return agent;
  }
  return null;
}

/** Resolve an explicit agent or auto-detect one. */
export function resolveAgent(explicit?: string): AgentInfo {
  if (explicit) return { name: explicit, command: explicit };

  const detected = detectAgent();
  if (!detected) {
    throw new Error(
      "No AI agent found. Install Claude Code, Pi, Codex, OpenCode, or GitHub Copilot.\n" +
        "Or specify one with: sandbox assist --agent <command>",
    );
  }
  return detected;
}
