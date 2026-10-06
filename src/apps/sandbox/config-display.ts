import chalk from "chalk";
import type {
  Config,
  ConfigOverrides,
  PersistPath,
  SettingsEntry,
} from "#modules/configuration/index.js";
import {
  getConfigurationService,
  getGlobalDockerfilePath,
  getProjectDockerfilePath,
} from "#modules/configuration/index.js";
import { mergeAllowedNetworks } from "#modules/network/index.js";
import {
  BASE_IMAGE,
  CACHE_VOLUME,
  getNamedVolumeName,
  getProjectImageName,
  USER_IMAGE,
} from "#modules/sandbox-resources/index.js";
import { getSandboxSettings } from "#modules/sandbox-settings/index.js";
import {
  getGlobalPersistDir,
  getProjectPersistDir,
} from "#modules/storage/index.js";
import { getRuntimeProvider } from "#platform/container-runtime/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { pathExists } from "#platform/filesystem/index.js";
import { getTerminal } from "#platform/terminal/index.js";
import {
  generateProjectSlug,
  redactEnvValue,
  splitColonString,
} from "#shared/text/index.js";

// Color helpers for consistent formatting
const formatPath = (p: string) => chalk.blue(p);
const formatStatus = (exists: boolean) =>
  exists ? chalk.green("✓") : chalk.dim("○");
const formatMode = (mode: string) =>
  mode === "rw" ? chalk.green(mode) : chalk.yellow(mode);
const formatLabel = (label: string) => chalk.cyan(label);
const writeLine = (message = "") => getTerminal().stdout.write(`${message}\n`);

/**
 * Display Docker images configuration
 */
async function displayImages(
  runtime: string,
  projectRoot: string,
): Promise<void> {
  writeLine(chalk.bold("Images:"));
  writeLine(`  ${formatLabel("Runtime:")} ${chalk.cyan(runtime)}`);
  writeLine(`  ${formatLabel("Base:")} ${chalk.cyan(BASE_IMAGE)}`);

  const userDockerfile = getGlobalDockerfilePath();
  if (await pathExists(userDockerfile)) {
    writeLine(
      `  ${formatLabel("User:")} ${chalk.cyan(USER_IMAGE)} ${chalk.dim(`(from ${userDockerfile})`)}`,
    );
  }

  const projectDockerfile = getProjectDockerfilePath(projectRoot);
  if (await pathExists(projectDockerfile)) {
    const slug = generateProjectSlug(projectRoot);
    writeLine(
      `  ${formatLabel("Project:")} ${chalk.cyan(getProjectImageName(slug))} ${chalk.dim("(from .sandbox/docker/Dockerfile)")}`,
    );
  }
}

/**
 * Format a single persist path entry for display
 */
function formatPersistPathEntry(p: PersistPath): string {
  const defaultInfo =
    p.default !== undefined ? chalk.dim(` [default: ${p.default}]`) : "";
  const onlyIfExistsInfo = p.onlyIfExists ? chalk.dim(" [only_if_exists]") : "";
  return `    ${formatPath(p.path)}${defaultInfo}${onlyIfExistsInfo}`;
}

/**
 * Display a list of persist paths with a header
 */
function displayPathList(paths: PersistPath[], header: string): void {
  if (paths.length === 0) return;
  writeLine(`\n  ${header}:`);
  for (const p of paths) {
    writeLine(formatPersistPathEntry(p));
  }
}

/**
 * Display directory existence status
 */
async function displayDirStatus(dirPath: string, label: string): Promise<void> {
  const exists = await pathExists(dirPath);
  const status = exists
    ? chalk.green("exists")
    : chalk.yellow("will be created");
  writeLine(`  ${formatStatus(exists)} ${label} ${status}`);
}

/**
 * Display persistent paths configuration
 */
async function displayPersistentPaths(
  persistPaths: PersistPath[],
  projectRoot: string,
): Promise<void> {
  const slug = generateProjectSlug(projectRoot);
  const globalPath = getGlobalPersistDir();
  const projectPersistPath = getProjectPersistDir(projectRoot);

  writeLine(`\n${chalk.bold("Persistent Paths:")}`);
  writeLine(`  ${formatLabel("Project slug:")} ${chalk.cyan(slug)}`);
  writeLine(`  ${formatLabel("Global dir:")} ${formatPath(globalPath)}`);
  writeLine(
    `  ${formatLabel("Project dir:")} ${formatPath(projectPersistPath)}`,
  );

  await displayDirStatus(globalPath, "Global directory");
  await displayDirStatus(projectPersistPath, "Project directory");

  if (persistPaths.length === 0) {
    writeLine(`\n  ${chalk.dim("No persist paths configured")}`);
    return;
  }

  const globalPaths = persistPaths.filter((p) => p.global);
  const projectSpecificPaths = persistPaths.filter((p) => !p.global);

  displayPathList(globalPaths, "Global paths (shared across projects)");
  displayPathList(projectSpecificPaths, "Project paths (isolated per project)");
}

/**
 * Display mounts configuration
 */
function displayMounts(config: Config, projectRoot: string): void {
  const currentDir = getHostEnvironment().currentWorkingDirectory;

  writeLine(`\n${chalk.bold("Mounts:")}`);
  const workspaceMode = config.readonly ? "ro" : "rw";
  writeLine(
    `  ${formatPath(projectRoot)} ${chalk.dim("→")} ${formatPath(projectRoot)} ${formatMode(workspaceMode)}`,
  );
  if (currentDir !== projectRoot) {
    writeLine(
      `  ${formatLabel("Working directory:")} ${formatPath(currentDir)}`,
    );
  }

  config.mounts.forEach((mount: string) => {
    const parts = splitColonString(mount);
    if (!parts[0] || !parts[1]) return;
    const mode = parts[2] || "ro";
    writeLine(
      `  ${formatPath(parts[0])} ${chalk.dim("→")} ${formatPath(parts[1])} ${formatMode(mode)}`,
    );
  });
}

/**
 * Display volumes configuration
 */
function displayVolumes(config: Config): void {
  writeLine(`\n${chalk.bold("Volumes:")}`);
  writeLine(`  ${chalk.cyan(CACHE_VOLUME)} ${chalk.dim("→")} /var/cache`);
  for (const p of config.persistPaths) {
    if (!p.useNamedVolume) continue;
    const volName = getNamedVolumeName(p.useNamedVolume);
    writeLine(`  ${chalk.cyan(volName)} ${chalk.dim("→")} ${p.path}`);
  }
}

/**
 * Display environment variables
 */
function displayEnvironment(env: string[]): void {
  const allEnv = env;

  if (allEnv.length > 0) {
    writeLine(`\n${chalk.bold("Environment Variables:")}`);

    allEnv.forEach((envVar) => {
      const [key, value] = envVar.split("=");
      if (!key || !value) return;

      const displayValue = redactEnvValue(key, value);
      writeLine(`  ${chalk.cyan(key)}${chalk.dim("=")}${displayValue}`);
    });
  }
}

/**
 * Display options configuration
 */
function displayOptions(config: Config): void {
  writeLine(`\n${chalk.bold("Options:")}`);
  writeLine(`  Readonly: ${config.readonly}`);
  if (config.runtime === "apple-container") {
    writeLine(
      `  Apple container DNS: ${chalk.cyan(config.runtimes["apple-container"].dns)}`,
    );
  }

  // Network settings
  if (config.fullNetwork) {
    writeLine(`  Full network: ${chalk.yellow("enabled")}`);
    if (config.noProxy) {
      writeLine(`  No proxy: ${chalk.yellow("enabled")}`);
    }
  } else if (config.allowNetwork.length > 0) {
    const networks = mergeAllowedNetworks(config.allowNetwork);
    writeLine(`  Allowed networks: ${chalk.cyan(networks.length.toString())}`);
    for (const line of networks) {
      writeLine(`    ${formatPath(line)}`);
    }
  }
}

/**
 * Display shared settings configuration
 */
async function displaySettings(
  entries: readonly SettingsEntry[],
): Promise<void> {
  const inspection = await getSandboxSettings().inspectHost(entries);
  writeLine(`\n${chalk.bold("Shared Settings:")}`);
  writeLine(
    `  ${formatLabel("Directory:")} ${formatPath(inspection.directory)} ${formatStatus(inspection.directoryExists)}`,
  );

  if (!inspection.directoryExists) {
    writeLine(`  ${chalk.dim("Not configured")}`);
    return;
  }
  if (inspection.settings.length === 0) {
    writeLine(`  ${chalk.yellow("No settings found")}`);
  } else {
    writeLine(
      `  ${formatLabel("Selected paths:")} ${chalk.cyan(inspection.settings.length.toString())}`,
    );
    for (const setting of inspection.settings) {
      writeLine(
        `    ${formatPath(setting.path)} ${chalk.dim("→")} ${formatPath(`/home/sandbox/${setting.path}`)} ${formatMode(setting.mode)}`,
      );
    }
  }
  for (const missingPath of inspection.missingPaths) {
    writeLine(`  ${chalk.yellow("Missing:")} ${formatPath(missingPath)}`);
  }
}

/**
 * Show merged configuration
 */
export async function showConfig(options: ConfigOverrides): Promise<void> {
  const { config, projectRoot, runtimeResolution } =
    await getConfigurationService().load(options);
  config.runtime = (
    await getRuntimeProvider().resolve(runtimeResolution)
  ).runtime.runtime;

  writeLine(chalk.bold("\nSandbox Configuration"));
  writeLine(chalk.bold("=====================\n"));

  await displayImages(config.runtime, projectRoot);
  await displayPersistentPaths(config.persistPaths, projectRoot);
  await displaySettings(config.settings);
  displayMounts(config, projectRoot);
  displayVolumes(config);
  displayEnvironment(config.env);
  displayOptions(config);

  writeLine("");
}
