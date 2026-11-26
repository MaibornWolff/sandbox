import chalk from "chalk";
import { getLogger } from "#platform/logging/index.js";
import {
  fetchLatestVersion,
  updateGlobalPackage,
} from "#platform/npm/index.js";
import {
  promptSelectionConfirmation,
  writeStandardOutput,
} from "#platform/terminal/index.js";
import { getErrorMessage, isPromptCancellation } from "#shared/errors/index.js";
import { getVersion, isNewerVersion } from "./package-version.js";
import { updateInstalledTemplates } from "./template-updating.js";

const PACKAGE_NAME = "@maibornwolff/sandbox";

function printVersionComparison(current: string, latest: string): void {
  writeStandardOutput();
  writeStandardOutput(`  Current version:  ${current}`);
  writeStandardOutput(`  Latest version:   ${latest}`);
  writeStandardOutput();
}

function printNextSteps(): void {
  writeStandardOutput();
  writeStandardOutput("Next steps:");
  writeStandardOutput(
    `  ${chalk.blue("→")} Run ${chalk.cyan("sandbox upgrade")}         to update all sandbox tools`,
  );
  writeStandardOutput(
    `  ${chalk.blue("→")} Run ${chalk.cyan("sandbox upgrade --user")}  to update user + project tools only`,
  );
}

async function checkForUpdate(): Promise<{
  currentVersion: string;
  latestVersion: string;
} | null> {
  const logger = getLogger();
  let latestVersion: string;
  try {
    latestVersion = await fetchLatestVersion(PACKAGE_NAME);
  } catch (error) {
    logger.error(getErrorMessage(error));
    return null;
  }

  const currentVersion = getVersion();
  if (!isNewerVersion(currentVersion, latestVersion)) {
    writeStandardOutput();
    logger.success(`Already on latest version (${currentVersion})`);
    return null;
  }
  return { currentVersion, latestVersion };
}

async function performUpdate(): Promise<boolean> {
  const logger = getLogger();
  writeStandardOutput();
  logger.info(`Updating ${PACKAGE_NAME}...`);
  try {
    await updateGlobalPackage(PACKAGE_NAME);
    return true;
  } catch (error) {
    writeStandardOutput();
    logger.error(getErrorMessage(error));
    return false;
  }
}

/** Update the installed CLI and then migrate installed configuration templates. */
export async function updateCommand(): Promise<void> {
  const logger = getLogger();
  try {
    logger.info("Checking for updates...");
    const result = await checkForUpdate();
    if (!result) return;

    printVersionComparison(result.currentVersion, result.latestVersion);
    const shouldUpdate = await promptSelectionConfirmation({
      message: `Update to ${result.latestVersion}?`,
      default: true,
    });
    if (!shouldUpdate || !(await performUpdate())) return;

    writeStandardOutput();
    logger.success(`Updated to ${result.latestVersion}`);
    // Only the new release knows its templates. This process still runs the old code.
    writeStandardOutput("\nChecking for configuration updates...");
    await updateInstalledTemplates();
    printNextSteps();
  } catch (error) {
    if (isPromptCancellation(error)) {
      writeStandardOutput("\nCancelled.");
      return;
    }
    throw error;
  }
}
