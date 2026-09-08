import type {
  SettingsEntry,
  SettingsMode,
} from "#modules/configuration/index.js";
import {
  exists,
  pathExists,
  resolveRealPath,
} from "#platform/filesystem/index.js";
import { resolveSettingsPaths } from "./settings-mount-resolution.js";
import { getSettingsDir } from "./settings-paths.js";

export interface InspectedSetting {
  readonly path: string;
  readonly mode: SettingsMode;
}

export interface SettingsInspection {
  readonly directory: string;
  readonly directoryExists: boolean;
  readonly settings: readonly InspectedSetting[];
  readonly missingPaths: readonly string[];
}

export async function inspectHostSettings(
  entries: readonly SettingsEntry[],
): Promise<SettingsInspection> {
  const directory = getSettingsDir();
  if (!(await exists(directory))) {
    return {
      directory,
      directoryExists: false,
      settings: [],
      missingPaths: entries
        .filter((entry) => !entry.path.startsWith("!"))
        .map((entry) => entry.path),
    };
  }
  const resolvedDirectory = await resolveRealPath(directory);
  const mountEntries = entries.filter((entry) => entry.mode === "mount");
  const mountPaths = await resolveSettingsPaths(
    resolvedDirectory,
    mountEntries.map((entry) => entry.path),
  );
  const settings: InspectedSetting[] = mountPaths.map((path) => ({
    path,
    mode: "mount",
  }));
  const missingPaths: string[] = [];

  for (const entry of entries.filter(
    (candidate) => candidate.mode === "copy",
  )) {
    const cleanPath = entry.path.replace(/\/$/, "");
    if (pathExists(`${resolvedDirectory}/${cleanPath}`)) {
      settings.push({ path: cleanPath, mode: "copy" });
    } else {
      missingPaths.push(entry.path);
    }
  }
  const exclusions = mountEntries
    .filter((entry) => entry.path.startsWith("!"))
    .map((entry) => entry.path);
  for (const entry of mountEntries.filter(
    (candidate) => !candidate.path.startsWith("!"),
  )) {
    const entryMatches = await resolveSettingsPaths(resolvedDirectory, [
      entry.path,
      ...exclusions,
    ]);
    if (entryMatches.length === 0) missingPaths.push(entry.path);
  }
  return { directory, directoryExists: true, settings, missingPaths };
}
