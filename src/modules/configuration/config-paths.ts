import * as path from "node:path";
import { getHostEnvironment } from "#platform/environment/index.js";
import { getLogger } from "#platform/logging/index.js";

const PROJECT_SANDBOX_DIR = ".sandbox";
const CONFIG_FILENAME = "config.toml";
const DOCKERFILE_PATH = path.join("docker", "Dockerfile");

/** @testonly */
export function getConfigHomeDir(): string {
  const environment = getHostEnvironment();
  const logger = getLogger();
  if (environment.variables.XDG_CONFIG_HOME) {
    logger.debug(`Using XDG_CONFIG_HOME: ${environment.configHomeDirectory}`);
    return environment.configHomeDirectory;
  }

  if (environment.platform === "win32") {
    logger.debug(
      `Using Windows config dir: ${environment.configHomeDirectory}`,
    );
    return environment.configHomeDirectory;
  }

  logger.debug(`Using default config dir: ${environment.configHomeDirectory}`);
  return environment.configHomeDirectory;
}

export function getSandboxConfigDir(): string {
  const configuredDirectory = getHostEnvironment().variables.SANDBOX_CONFIG_DIR;
  const logger = getLogger();
  if (configuredDirectory) {
    logger.debug(`Using SANDBOX_CONFIG_DIR: ${configuredDirectory}`);
    return configuredDirectory;
  }

  const sandboxDirectory = path.join(getConfigHomeDir(), "sandbox");
  logger.debug(`Sandbox config dir: ${sandboxDirectory}`);
  return sandboxDirectory;
}

export function getGlobalConfigPath(): string {
  return path.join(getSandboxConfigDir(), CONFIG_FILENAME);
}

export function getProjectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_SANDBOX_DIR, CONFIG_FILENAME);
}

export function getProjectSandboxDir(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_SANDBOX_DIR);
}

export function getGlobalDockerfilePath(): string {
  return path.join(getSandboxConfigDir(), DOCKERFILE_PATH);
}

export function getProjectDockerfilePath(projectRoot: string): string {
  return path.join(getProjectSandboxDir(projectRoot), DOCKERFILE_PATH);
}
