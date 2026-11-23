import { deduplicateCommandPatterns } from "#modules/host-command-escape/index.js";
import { parseEnvList } from "#platform/environment/index.js";
import { getLogger } from "#platform/logging/index.js";
import type { Config } from "./config.js";
import { parseAllowedNetwork, parsePort } from "./config-value-parsing.js";
import {
  normalizePersistPath,
  normalizeSettingsEntry,
  type TomlConfig,
} from "./toml-config-schema.js";

function applySessionWrapperOverride(
  config: Config,
  toml: TomlConfig,
  isProject: boolean,
): void {
  const wrapper = toml.session?.command_wrapper;
  // ignore empty wrapper
  if (!wrapper?.length) return;

  // check if user and project wrappers differ
  config.session.wrapperConflict =
    isProject &&
    config.session.commandWrapper.length > 0 &&
    JSON.stringify(config.session.commandWrapper) !== JSON.stringify(wrapper);
  config.session.commandWrapper = [...wrapper];
}

/** Project mounts must be resolved and approved before merging. */
export function applyTomlConfig(options: {
  readonly config: Config;
  readonly toml: TomlConfig;
  readonly source: "global" | "project";
  readonly mounts: readonly string[];
  readonly variables: Readonly<Record<string, string>>;
}): void {
  const { config, toml, source, mounts, variables } = options;
  getLogger().debug(
    `${source === "global" ? "Global" : "Project"} config contributions:`,
  );

  // Runtime (override)
  if (toml.runtime !== undefined) {
    config.runtime = toml.runtime;
    getLogger().debug(`  Runtime: ${toml.runtime}`);
  }

  // Runtime-specific options (override supplied values)
  const appleContainerOptions = toml.runtimes?.["apple-container"];
  if (appleContainerOptions?.dns !== undefined) {
    config.runtimes["apple-container"] = { dns: appleContainerOptions.dns };
    getLogger().debug(`  Apple container DNS: ${appleContainerOptions.dns}`);
  }

  // Mounts (accumulate)
  config.mounts.push(...mounts);
  getLogger().debug(`  Mounts: ${mounts.length} added`);

  applySessionWrapperOverride(config, toml, source === "project");

  // Environment variables (accumulate)
  if (toml.env !== undefined) {
    const envVars = parseEnvList(toml.env, variables);
    config.env.push(...envVars);
    getLogger().debug(`  Environment variables: ${envVars.length} added`);
  }

  // Readonly (override)
  if (toml.readonly !== undefined) {
    config.readonly = toml.readonly;
    getLogger().debug(`  Readonly mode: ${toml.readonly}`);
  }

  if (toml.clipboard !== undefined) {
    config.clipboard = toml.clipboard;
    getLogger().debug(`  Clipboard: ${toml.clipboard}`);
  }

  // Settings (accumulate, normalize paths and default mode)
  if (toml.settings !== undefined) {
    const normalizedSettings = toml.settings.map(normalizeSettingsEntry);
    config.settings.push(...normalizedSettings);
    getLogger().debug(
      `  Settings patterns: ${normalizedSettings.length} added`,
    );
  }

  // Persist paths (accumulate, normalize to PersistPath format)
  if (toml.persist_paths !== undefined) {
    const normalizedPaths = toml.persist_paths.map(normalizePersistPath);
    config.persistPaths.push(...normalizedPaths);
    getLogger().debug(`  Persist paths: ${normalizedPaths.length} added`);
  }

  // Ports (accumulate)
  if (toml.ports !== undefined) {
    const ports = toml.ports.map(parsePort);
    config.ports.push(...ports);
    getLogger().debug(`  Ports: ${ports.length} added`);
  }

  // Allowed networks (accumulate)
  if (toml.allow_network !== undefined) {
    const networks = toml.allow_network.map(parseAllowedNetwork);
    config.allowNetwork.push(...networks);
    getLogger().debug(`  Allowed networks: ${networks.length} added`);
  }

  // Allowed host commands (accumulate)
  if (toml.allow_host_commands !== undefined) {
    const patterns = toml.allow_host_commands.map((rule) => rule.pattern);
    config.allowHostCommands = deduplicateCommandPatterns([
      ...config.allowHostCommands,
      ...patterns,
    ]);
    getLogger().debug(`  Allowed host command rules: ${patterns.length} added`);
  }

  // Full network (override)
  if (toml.full_network !== undefined) {
    config.fullNetwork = toml.full_network;
    getLogger().debug(`  Full network: ${toml.full_network}`);
  }

  // No proxy (override)
  if (toml.no_proxy !== undefined) {
    config.noProxy = toml.no_proxy;
    getLogger().debug(`  No proxy: ${toml.no_proxy}`);
  }

  // Shared memory size (override)
  if (toml.shm_size !== undefined) {
    config.shmSize = toml.shm_size;
    getLogger().debug(`  SHM size: ${toml.shm_size}`);
  }
}
