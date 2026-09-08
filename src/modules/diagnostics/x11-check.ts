import chalk from "chalk";
import { checkXHostAccess, detectX11 } from "#platform/environment/index.js";
import { getTerminal } from "#platform/terminal/index.js";

interface X11CheckResult {
  readonly available: boolean;
  readonly display: string | null;
  readonly xhostConfigured: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export async function checkX11(): Promise<X11CheckResult> {
  const [x11Config, xhostAccess] = await Promise.all([
    detectX11(),
    checkXHostAccess(),
  ]);
  const warnings: string[] = [];
  if (!x11Config.available) {
    warnings.push("X11 not available - clipboard and GUI features won't work");
  } else if (!xhostAccess.configured) {
    warnings.push(
      "X11 available but xhost not configured for container access",
    );
  }
  return {
    available: x11Config.available,
    display: x11Config.display,
    xhostConfigured: xhostAccess.configured,
    errors: [],
    warnings,
  };
}

function renderX11Status(result: X11CheckResult): string {
  const lines = [chalk.bold("\nDisplay")];
  if (result.available && result.xhostConfigured) {
    lines.push(`  ${chalk.green("✓")} X11 available (${result.display})`);
  } else if (result.available) {
    lines.push(`  ${chalk.yellow("⚠")} X11 detected but not configured`);
    lines.push(
      chalk.dim("    → Run 'sandbox setup-x11' to enable clipboard support"),
    );
  } else {
    lines.push(`  ${chalk.yellow("⚠")} X11 not available`);
    lines.push(chalk.dim("    → Image copy/paste and GUI features won't work"));
    lines.push(
      chalk.dim("    → Run 'sandbox setup-x11' for setup instructions"),
    );
  }
  return lines.join("\n");
}

export function displayX11Status(result: X11CheckResult): void {
  getTerminal().stdout.write(`${renderX11Status(result)}\n`);
}
