import chalk from "chalk";
import { getClock } from "#platform/clock/index.js";
import { getLogger } from "#platform/logging/index.js";
import { fetchLatestVersion } from "#platform/npm/index.js";
import { readState, writeState } from "#platform/state/index.js";
import { writeStandardError } from "#platform/terminal/index.js";
import { getVersion, isNewerVersion } from "./package-version.js";

const PACKAGE_NAME = "@maibornwolff/sandbox";
const UPDATE_CHECK_CACHE_MILLISECONDS = 24 * 60 * 60 * 1_000;

/** @testonly */
export function formatAvailableUpdateWarning(
  currentVersion: string,
  latestVersion: string | null,
): string | null {
  if (
    currentVersion === "0.0.0-development" ||
    latestVersion === null ||
    !isNewerVersion(currentVersion, latestVersion)
  ) {
    return null;
  }
  return `${chalk.yellow("↑ Sandbox update available:")} ${chalk.dim(currentVersion)} → ${chalk.cyan.bold(latestVersion)}  (run ${chalk.cyan.bold("sandbox update")})\n`;
}

/**
 * Warn from the cached registry result and refresh an expired cache.
 * The returned promise is the complete refresh lifecycle and never rejects.
 */
export async function warnIfUpdateAvailable(): Promise<void> {
  const currentVersion = getVersion();
  const state = readState();
  const latestVersion =
    typeof state.latestVersion === "string" ? state.latestVersion : null;

  const warning = formatAvailableUpdateWarning(currentVersion, latestVersion);
  if (warning) writeStandardError(warning);

  const now = getClock().now();
  const checkedAt =
    typeof state.latestVersionCheckedAt === "number"
      ? state.latestVersionCheckedAt
      : null;
  if (checkedAt !== null && now - checkedAt < UPDATE_CHECK_CACHE_MILLISECONDS) {
    getLogger().debug("Using cached Sandbox update check");
    return;
  }

  try {
    const version = await fetchLatestVersion(PACKAGE_NAME);
    writeState({ latestVersion: version, latestVersionCheckedAt: now });
    getLogger().debug("Refreshed Sandbox update cache");
  } catch (error) {
    getLogger().debug(
      `Sandbox update check failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }
}
