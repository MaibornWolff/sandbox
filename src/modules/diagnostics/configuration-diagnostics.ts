import type {
  PersistPathInput,
  SettingsEntryInput,
} from "#modules/configuration/index.js";
import {
  normalizePersistPath,
  validateConfig,
} from "#modules/configuration/index.js";
import { loadGlobalConfigForDiagnostics } from "./global-config-loading.js";

export interface ConfigurationDiagnostics {
  exists: boolean;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** @testonly */
export function checkMountConflicts(
  persistPaths: PersistPathInput[],
  settings: SettingsEntryInput[],
): string[] {
  const warnings: string[] = [];
  const normalizedPaths = persistPaths.map(
    (persistPath) => normalizePersistPath(persistPath).path,
  );
  const hasHomePersist = normalizedPaths.some(
    (persistPath) =>
      persistPath === "/home/sandbox" ||
      persistPath.startsWith("/home/sandbox/"),
  );

  if (!hasHomePersist) return warnings;

  const deprecatedPatterns = [".claude.json", ".codex/*.toml"];
  for (const setting of settings) {
    const settingPath = typeof setting === "string" ? setting : setting.path;
    if (
      deprecatedPatterns.some(
        (pattern) =>
          settingPath === pattern || settingPath.startsWith(`${pattern}/`),
      )
    ) {
      warnings.push(
        `Settings pattern "${settingPath}" is now auto-persisted via /home/sandbox`,
      );
    }
  }

  return warnings;
}

export function checkConfigurationDiagnostics(): ConfigurationDiagnostics {
  const result: ConfigurationDiagnostics = {
    exists: false,
    valid: true,
    errors: [],
    warnings: [],
  };
  const { config, loadError } = loadGlobalConfigForDiagnostics();

  if (loadError !== null) {
    result.exists = true;
    result.valid = false;
    result.errors.push(loadError);
    return result;
  }
  if (!config) {
    result.warnings.push(
      "No global config found. Run 'sandbox init' to create one.",
    );
    return result;
  }

  result.exists = true;

  const validation = validateConfig(config);
  result.warnings.push(...validation.warnings);
  result.errors.push(...validation.errors);
  result.valid = validation.valid;

  if (validation.suggestRegenerate) {
    result.warnings.push(
      'Run "sandbox init" and select "config.toml" to regenerate with updated defaults.',
    );
  }

  result.warnings.push(
    ...checkMountConflicts(config.persist_paths ?? [], config.settings ?? []),
  );
  return result;
}
