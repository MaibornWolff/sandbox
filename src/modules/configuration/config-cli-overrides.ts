import { parseEnvList } from "#platform/environment/index.js";
import type { Config, ConfigOverrides } from "./config.js";
import { parseAllowedNetwork, parsePort } from "./config-value-parsing.js";
import { resolveExistingMounts } from "./mount-path-resolution.js";

/**
 * Normalize CLI option to array (handles string | string[] | undefined)
 */
function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Apply CLI options to config object
 */
export function applyCliOptions(
  config: Config,
  cliOptions: ConfigOverrides,
  projectDir: string,
  variables: Readonly<Record<string, string>>,
): void {
  // Array options (accumulate)
  const mounts = toArray(cliOptions.mount);
  if (mounts.length > 0) {
    config.mounts.push(...resolveExistingMounts(mounts, projectDir, false));
  }

  const envs = toArray(cliOptions.env);
  if (envs.length > 0) {
    config.env.push(...parseEnvList(envs, variables));
  }

  const ports = toArray(cliOptions.port);
  if (ports.length > 0) {
    config.ports.push(...ports.map(parsePort));
  }

  const networks = toArray(cliOptions.allowNetwork);
  if (networks.length > 0) {
    config.allowNetwork.push(...networks.map(parseAllowedNetwork));
  }

  // Override options
  if (cliOptions.readonly !== undefined) config.readonly = cliOptions.readonly;
  if (cliOptions.clipboard !== undefined)
    config.clipboard = cliOptions.clipboard;
  if (cliOptions.fullNetwork !== undefined)
    config.fullNetwork = cliOptions.fullNetwork;
  if (cliOptions.proxy !== undefined) config.noProxy = !cliOptions.proxy;
}
