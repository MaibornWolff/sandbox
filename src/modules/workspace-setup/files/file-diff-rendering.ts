import chalk from "chalk";
import { createTwoFilesPatch } from "diff";
import { writeStandardOutput } from "#platform/terminal/index.js";

/**
 * Generate unified diff between two strings.
 * Returns empty string if content is identical.
 */
export function generateUnifiedDiff(
  oldContent: string,
  newContent: string,
  oldLabel = "current",
  newLabel = "updated",
): string {
  if (oldContent === newContent) return "";

  return createTwoFilesPatch(
    oldLabel,
    newLabel,
    oldContent,
    newContent,
    "",
    "",
    {
      context: 3,
    },
  );
}

/**
 * Print a unified diff with colors.
 * Red for removed lines, green for added lines, cyan for hunk headers.
 */
export function printColoredDiff(diff: string): void {
  const lines = diff.split("\n");

  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++")) {
      // File headers - dim
      writeStandardOutput(chalk.dim(line));
    } else if (line.startsWith("@@")) {
      // Hunk headers - cyan
      writeStandardOutput(chalk.cyan(line));
    } else if (line.startsWith("-")) {
      // Removed lines - red
      writeStandardOutput(chalk.red(line));
    } else if (line.startsWith("+")) {
      // Added lines - green
      writeStandardOutput(chalk.green(line));
    } else {
      // Context lines
      writeStandardOutput(chalk.dim(line));
    }
  }
}
