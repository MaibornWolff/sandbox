import chalk from "chalk";
import {
  detectX11,
  getHostEnvironment,
  type X11Config,
} from "#platform/environment/index.js";
import { getTerminal } from "#platform/terminal/index.js";
import type { X11SetupStatus } from "./x11-setup.js";
import { checkX11Setup, getSetupInstructions } from "./x11-setup.js";

function writeLine(...parts: readonly string[]): void {
  getTerminal().stdout.write(`${parts.join(" ")}\n`);
}

export async function setupX11Command(): Promise<void> {
  writeLine(chalk.bold("\nChecking X11 setup...\n"));
  const currentPlatform = getHostEnvironment().platform;
  const [x11Config, setupStatus] = await Promise.all([
    detectX11(),
    checkX11Setup(),
  ]);
  displaySystemStatus(currentPlatform, x11Config, setupStatus);

  if (
    setupStatus.xServerInstalled &&
    setupStatus.xServerRunning &&
    setupStatus.xHostConfigured
  ) {
    displaySuccessMessage();
  } else {
    displaySetupInstructions(currentPlatform, setupStatus);
  }
}

function displaySystemStatus(
  currentPlatform: NodeJS.Platform,
  x11Config: X11Config,
  setupStatus: X11SetupStatus,
): void {
  writeLine(chalk.bold("Platform:"), getPlatformName(currentPlatform));
  writeLine(
    chalk.bold("X Server:"),
    setupStatus.xServerInstalled
      ? setupStatus.xServerRunning
        ? chalk.green("✓ Running")
        : chalk.yellow("⚠ Installed but not running")
      : chalk.red("✗ Not installed"),
  );
  writeLine(
    chalk.bold("X11 Available:"),
    x11Config.available
      ? chalk.green(`✓ Yes (DISPLAY=${x11Config.display})`)
      : chalk.red("✗ No"),
  );
  if (currentPlatform !== "win32") {
    writeLine(
      chalk.bold("xhost Access:"),
      setupStatus.xHostConfigured
        ? chalk.green("✓ Configured")
        : chalk.yellow("⚠ Not configured"),
    );
  }
  if (currentPlatform === "darwin" && setupStatus.xServerInstalled) {
    writeLine(
      chalk.bold("Network Clients:"),
      setupStatus.networkClientsEnabled
        ? chalk.green("✓ Enabled")
        : chalk.yellow("⚠ Disabled"),
    );
  }
}

function displaySuccessMessage(): void {
  writeLine(chalk.green.bold("\n✓ X11 clipboard is fully configured!\n"));
  writeLine("You can now use clipboard commands in the sandbox:");
  writeLine("  • echo 'test' | xclip -selection clipboard");
  writeLine("  • xclip -selection clipboard -o");
  writeLine("  • sandbox-container-tools x11 test  (verify X11 connection)\n");
}

function displaySetupInstructions(
  currentPlatform: NodeJS.Platform,
  setupStatus: X11SetupStatus,
): void {
  writeLine(chalk.yellow.bold("\n⚠ X11 clipboard setup incomplete\n"));
  writeLine(chalk.bold("Setup Instructions:\n"));
  const instructions =
    setupStatus.recommendations.length > 0
      ? setupStatus.recommendations
      : getSetupInstructions(currentPlatform);
  for (const instruction of instructions) writeLine(`   ${instruction}`);
  writeLine();
  writeLine(chalk.dim("Full documentation: docs/X11-SETUP.md\n"));
}

function getPlatformName(platformId: NodeJS.Platform): string {
  switch (platformId) {
    case "darwin":
      return "macOS (darwin)";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    default:
      return platformId;
  }
}
