import * as path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  ensureDirectory,
  pathExists,
  readTextFile,
  writeTextFile,
} from "#platform/filesystem/index.js";
import type { AgentConfigDef } from "./agent-config-catalog.js";
import type { DetectedConfig } from "./agent-config-copying.js";

/**
 * Apply bypass settings to a config's settings file
 */
export function applyBypassSettings(config: DetectedConfig): boolean {
  if (!config.addBypassSettings || !config.settingsFileRelative) {
    return false;
  }

  const targetSettingsPath = path.join(
    config.targetBaseDir,
    config.settingsFileRelative,
  );

  if (!pathExists(targetSettingsPath)) {
    return false;
  }

  const isToml = targetSettingsPath.endsWith(".toml");

  try {
    const content = readTextFile(targetSettingsPath);
    const parsed = isToml
      ? (parseToml(content) as Record<string, unknown>)
      : (JSON.parse(content) as Record<string, unknown>);

    config.addBypassSettings(parsed);

    const output = isToml
      ? stringifyToml(parsed)
      : JSON.stringify(parsed, null, 2);

    writeTextFile(targetSettingsPath, output);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if config has bypass settings available
 */
export function canAddBypass(config: DetectedConfig): boolean {
  return config.addBypassSettings !== null;
}

/**
 * Check if a config definition supports bypass settings
 */
export function canAddBypassDef(configDef: AgentConfigDef): boolean {
  return configDef.addBypassSettings !== null;
}

/**
 * Create a minimal bypass-only config for an agent
 * Returns true if created successfully, false if no bypass support or error
 */
export function createMinimalBypassConfig(
  configDef: AgentConfigDef,
  targetBaseDir: string,
): boolean {
  if (!configDef.addBypassSettings || !configDef.settingsFile) {
    return false;
  }

  const targetPath = path.join(targetBaseDir, configDef.settingsFile);
  const isToml = targetPath.endsWith(".toml");

  try {
    // Create an empty config and apply bypass settings
    const config: Record<string, unknown> = {};
    configDef.addBypassSettings(config);

    // Serialize to appropriate format
    const content = isToml
      ? stringifyToml(config)
      : JSON.stringify(config, null, 2);

    // Ensure directory exists and write file
    ensureDirectory(path.dirname(targetPath));
    writeTextFile(targetPath, content);

    return true;
  } catch {
    return false;
  }
}
