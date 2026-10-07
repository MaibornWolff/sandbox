import * as path from "node:path";
import chalk from "chalk";
import { getClock } from "#platform/clock/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { getPackageRootPath } from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import { fetchLatestVersion } from "#platform/npm/index.js";
import { getProcessManager } from "#platform/process/index.js";
import {
  claimUpdateRefresh,
  finishUpdateRefresh,
  readUpdateCache,
  startUpdateRefresh,
} from "#platform/state/index.js";
import { writeStandardError } from "#platform/terminal/index.js";
import { getVersion, isNewerVersion } from "./package-version.js";

const PACKAGE_NAME = "@maibornwolff/sandbox";
export const UPDATE_CHECK_WORKER_ARGUMENT = "--internal-update-check";

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

function reportFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const summary = message
    .split("\n")
    .slice(0, 2)
    .map((line) => line.trim())
    .join(": ")
    .slice(0, 500);
  getLogger().debug(`Sandbox update check failed: ${summary}`);
  return summary;
}

/** Only a later invocation can show the worker's result. */
export function warnIfUpdateAvailable(): void {
  try {
    const cache = readUpdateCache();
    const warning = formatAvailableUpdateWarning(
      getVersion(),
      cache.latestVersion ?? null,
    );
    if (warning) writeStandardError(warning);
    if (cache.error)
      getLogger().debug(`Previous Sandbox update check failed: ${cache.error}`);
    const token = claimUpdateRefresh(getClock().now());
    if (token === undefined) {
      getLogger().debug("Using cached Sandbox update check or refresh backoff");
      return;
    }
    launchUpdateWorker(token);
  } catch (error) {
    reportFailure(error);
  }
}

function launchUpdateWorker(token: string): void {
  const recordFailure = (error: unknown) => {
    const summary = reportFailure(error);
    try {
      finishUpdateRefresh(token, getClock().now(), { error: summary });
    } catch (cacheError) {
      reportFailure(cacheError);
    }
  };
  try {
    const executablePath = getHostEnvironment().executablePath;
    if (!executablePath) throw new Error("Node executable path is unavailable");
    const worker = getProcessManager().start({
      command: executablePath,
      args: [
        path.join(getPackageRootPath(), "dist", "apps", "sandbox", "main.js"),
        UPDATE_CHECK_WORKER_ARGUMENT,
        token,
      ],
      lifetime: "detached",
      interaction: { mode: "non-interactive" },
      stdio: "ignore",
    });
    getLogger().debug(
      `Started background ${chalk.cyan("Sandbox update check")}`,
    );
    void worker.result.then((result) => {
      if (result.exitCode !== 0)
        recordFailure(
          new Error(`Update worker exited with code ${result.exitCode}`),
        );
    }, recordFailure);
  } catch (error) {
    recordFailure(error);
  }
}

export async function runUpdateCheckWorker(token: string): Promise<void> {
  if (!startUpdateRefresh(token, getClock().now())) return;
  try {
    const latestVersion = await fetchLatestVersion(PACKAGE_NAME);
    if (
      !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(
        latestVersion,
      )
    ) {
      throw new Error("npm returned an invalid Sandbox release version");
    }
    finishUpdateRefresh(token, getClock().now(), { latestVersion });
    getLogger().debug("Refreshed Sandbox update cache");
  } catch (error) {
    finishUpdateRefresh(token, getClock().now(), {
      error: reportFailure(error),
    });
  }
}
