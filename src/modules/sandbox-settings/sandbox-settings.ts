import type { SettingsEntry } from "#modules/configuration/index.js";
import {
  type CreateSettingsContainerSetupOptions,
  createContainerSettingsSetup,
  type PreparedSettings,
} from "./container-settings-setup.js";
import { applyContainerStartSettings } from "./container-start-settings.js";
import {
  inspectHostSettings,
  type SettingsInspection,
} from "./host-settings-inspection.js";
import { getSettingsDir } from "./settings-paths.js";
import { syncNewContainerSettings } from "./settings-synchronization.js";

/** @lintignore Public lifecycle-oriented settings contract. */
export interface SandboxSettings {
  getHostDirectory(): string;
  createContainerSetup(
    options: CreateSettingsContainerSetupOptions,
  ): Promise<PreparedSettings>;
  applyOnContainerStart(): Promise<void>;
  syncNewSettingsOnContainerStop(): Promise<readonly string[]>;
  inspectHost(entries: readonly SettingsEntry[]): Promise<SettingsInspection>;
}

const sandboxSettings: SandboxSettings = {
  getHostDirectory: getSettingsDir,
  createContainerSetup: createContainerSettingsSetup,
  applyOnContainerStart: applyContainerStartSettings,
  syncNewSettingsOnContainerStop: syncNewContainerSettings,
  inspectHost: inspectHostSettings,
};

export function getSandboxSettings(): SandboxSettings {
  return sandboxSettings;
}

/** @lintignore Public settings lifecycle result contracts. */
export type {
  CreateSettingsContainerSetupOptions,
  PreparedSettings,
  SettingsInspection,
};
