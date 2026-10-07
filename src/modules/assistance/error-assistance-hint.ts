import chalk from "chalk";

const GLOBAL_OPTIONS_WITH_VALUES = new Set([
  "-m",
  "--mount",
  "-e",
  "--env",
  "-p",
  "--port",
  "-n",
  "--allow-network",
]);

const ASSIST_COMMAND = chalk.bold.cyan("sandbox assist");

export function formatErrorAssistHint(): string {
  return [
    `Need help fixing this? Run ${ASSIST_COMMAND} to start an agent with your sandbox context.`,
    "Paste the error above into the chat and say what you were trying to do.",
  ].join("\n");
}

function getTopLevelCommand(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--") return null;
    if (GLOBAL_OPTIONS_WITH_VALUES.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    if (arg.startsWith("-") && arg !== "-") continue;
    return arg;
  }
  return null;
}

export function shouldShowErrorAssistHint(argv: string[]): boolean {
  return getTopLevelCommand(argv) !== "assist";
}
