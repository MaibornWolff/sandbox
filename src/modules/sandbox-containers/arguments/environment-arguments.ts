import { getHostEnvironment } from "#platform/environment/index.js";
import { getLogger } from "#platform/logging/index.js";

function isStartupOwnedEnvironmentName(name: string): boolean {
  return (
    name === "SANDBOX" ||
    name.startsWith("SANDBOX_") ||
    name === "CLAUDE_CODE_SSE_PORT" ||
    name === "DISPLAY" ||
    name === "X11_AVAILABLE"
  );
}

export function validateConfiguredEnvironment(
  environment: readonly string[],
): void {
  for (const assignment of environment) {
    const name = assignment.slice(0, assignment.indexOf("="));
    if (isStartupOwnedEnvironmentName(name)) {
      throw new Error(`Environment variable ${name} is reserved for Sandbox`);
    }
  }
}

export function logEnvironmentVariables(
  scope: "Startup" | "Session",
  env: readonly string[],
): void {
  if (env.length === 0) return;
  const logger = getLogger();
  logger.debug(`${scope} environment variables (${env.length}):`);
  for (const entry of env) {
    const [key] = entry.split("=", 1);
    const suffix = entry.includes("=") ? "<set>" : "<passthrough>";
    logger.debug(`  ${key}=${suffix}`);
  }
}

function getContainerTerm(hostTerm: string | undefined): string | undefined {
  if (!hostTerm) return undefined;
  const knownPortableTerms = new Set([
    "dumb",
    "linux",
    "screen",
    "screen-256color",
    "tmux",
    "tmux-256color",
    "vt100",
    "xterm",
    "xterm-color",
    "xterm-256color",
  ]);
  return knownPortableTerms.has(hostTerm) ? hostTerm : "xterm-256color";
}

export function getSessionEnvironmentVariables(): Array<{
  name: string;
  value: string | undefined;
}> {
  const variables = getHostEnvironment().variables;
  return [
    { name: "TERM", value: getContainerTerm(variables.TERM) },
    { name: "COLORTERM", value: variables.COLORTERM },
    { name: "TZ", value: variables.TZ },
    { name: "TERM_PROGRAM", value: variables.TERM_PROGRAM },
    { name: "TERM_PROGRAM_VERSION", value: variables.TERM_PROGRAM_VERSION },
    { name: "VTE_VERSION", value: variables.VTE_VERSION },
    { name: "WT_SESSION", value: variables.WT_SESSION },
    { name: "KONSOLE_VERSION", value: variables.KONSOLE_VERSION },
    { name: "ITERM_SESSION_ID", value: variables.ITERM_SESSION_ID },
    { name: "KITTY_PID", value: variables.KITTY_PID },
  ];
}

export function addIdeBridgePortEnvironment(
  args: string[],
): string | undefined {
  const idePort = getHostEnvironment().variables.CLAUDE_CODE_SSE_PORT;
  if (idePort) args.push("-e", `CLAUDE_CODE_SSE_PORT=${idePort}`);
  return idePort;
}
