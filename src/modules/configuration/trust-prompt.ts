import chalk from "chalk";
import { splitColonString } from "#shared/text/index.js";
import { formatConfigPath } from "./config-path-display.js";

function formatMountAccess(mount: string): string {
  const [source = "", destination = "", mode] = splitColonString(mount);
  const access = mode === "rw" ? "READ WRITE" : "READ ONLY";
  return `  ${chalk.bold(access)}  ${formatConfigPath(source)} → ${formatConfigPath(destination)}`;
}

export function formatProjectMountAccess(mounts: readonly string[]): string {
  const lines = [""];
  if (mounts.length > 0) {
    lines.push(
      "Additional host paths requested by this project:",
      ...mounts.map(formatMountAccess),
      "",
      "Read-only paths can be read by container processes.",
      "Read-write paths can also be changed or deleted.",
    );
  } else {
    lines.push("No additional host mounts requested by this project.");
  }
  lines.push("", "Trust also approves the other settings in .sandbox.", "");
  return lines.join("\n");
}

export function formatTrustPrompt(): string {
  return `  ${chalk.yellow("Trust this project config?")} `;
}
