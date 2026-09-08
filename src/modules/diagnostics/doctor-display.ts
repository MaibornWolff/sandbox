import chalk from "chalk";
import { getTerminal } from "#platform/terminal/index.js";
import type { ConfigurationDiagnostics } from "./configuration-diagnostics.js";
import type { SettingsDiagnostics } from "./settings-diagnostics.js";

export interface DoctorSummary {
  errors: number;
  warnings: number;
}

function write(lines: readonly string[]): void {
  getTerminal().stdout.write(`${lines.join("\n")}\n`);
}

export function displayConfigurationDiagnostics(
  result: ConfigurationDiagnostics,
): void {
  const lines = [chalk.bold("\nConfiguration")];
  if (!result.exists) {
    lines.push(
      `  ${chalk.yellow("⚠")} No config file found`,
      chalk.dim("    → Run 'sandbox init' to create configuration"),
    );
  } else if (result.valid && result.warnings.length === 0) {
    lines.push(`  ${chalk.green("✓")} Config syntax valid`);
  } else if (result.valid) {
    lines.push(`  ${chalk.yellow("⚠")} Config has warnings`);
    lines.push(
      ...result.warnings.map((warning) => chalk.dim(`    → ${warning}`)),
    );
  } else {
    lines.push(`  ${chalk.red("✗")} Config invalid`);
    lines.push(...result.errors.map((error) => chalk.dim(`    → ${error}`)));
  }
  write(lines);
}

export function displaySettingsDiagnostics(result: SettingsDiagnostics): void {
  const lines = [chalk.bold("\nSettings")];
  if (!result.dirExists) {
    lines.push(
      `  ${chalk.dim("−")} Settings directory not created`,
      chalk.dim("    → Run 'sandbox init' to create settings"),
    );
  } else if (result.unmatchedPatterns.length === 0) {
    lines.push(
      `  ${chalk.green("✓")} All settings sources exist (${result.mountedFiles.length} mounted, ${result.copiedFiles.length} copied)`,
    );
  } else {
    lines.push(
      `  ${chalk.dim("ℹ")} ${result.unmatchedPatterns.length} pattern(s) without matches (ignored)`,
      ...result.unmatchedPatterns.map((pattern) =>
        chalk.dim(`    → "${pattern}"`),
      ),
      chalk.dim(
        "    → These patterns are skipped. Remove them from config if unused.",
      ),
    );
  }
  write(lines);
}

export function displayDoctorSummary(summary: DoctorSummary): void {
  const lines = [""];
  if (summary.errors === 0 && summary.warnings === 0) {
    lines.push(chalk.green("All checks passed!"));
  } else {
    const parts: string[] = [];
    if (summary.warnings > 0) {
      parts.push(
        `${summary.warnings} warning${summary.warnings > 1 ? "s" : ""}`,
      );
    }
    if (summary.errors > 0) {
      parts.push(`${summary.errors} error${summary.errors > 1 ? "s" : ""}`);
    }
    lines.push(`Summary: ${parts.join(", ")}`);
  }
  write(lines);
}
