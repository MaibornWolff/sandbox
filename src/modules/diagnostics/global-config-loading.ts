import chalk from "chalk";
import {
  getGlobalConfigPath,
  loadTomlConfig,
  type TomlConfig,
} from "#modules/configuration/index.js";
import { getLogger } from "#platform/logging/index.js";
import { getErrorMessage } from "#shared/errors/index.js";

export interface GlobalConfigLoadResult {
  readonly config: TomlConfig | null;
  readonly loadError: string | null;
}

/**
 * Load the global config for diagnostics. A broken config file must become a
 * reported finding instead of a crash, so load errors are captured here.
 */
export function loadGlobalConfigForDiagnostics(): GlobalConfigLoadResult {
  const configPath = getGlobalConfigPath();
  const logger = getLogger();
  logger.debug(
    `Loading global config for diagnostics: ${chalk.dim(configPath)}`,
  );
  try {
    return { config: loadTomlConfig(configPath), loadError: null };
  } catch (error) {
    const loadError = getErrorMessage(error);
    logger.debug(`Global config load failed: ${loadError}`);
    return { config: null, loadError };
  }
}
