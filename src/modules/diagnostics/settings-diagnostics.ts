import * as path from "node:path";
import {
  getGlobalConfigPath,
  loadTomlConfig,
  normalizeSettingsEntry,
  normalizeSettingsPattern,
  type SettingsEntryInput,
} from "#modules/configuration/index.js";
import { getSandboxSettings } from "#modules/sandbox-settings/index.js";
import { pathExists } from "#platform/filesystem/index.js";

export interface SettingsDiagnostics {
  dirExists: boolean;
  patterns: SettingsEntryInput[];
  matchedFiles: string[];
  mountedFiles: string[];
  copiedFiles: string[];
  unmatchedPatterns: string[];
  warnings: string[];
}

function isGlobSegment(segment: string): boolean {
  return /[*?[\]{}]/.test(segment);
}

/** @testonly */
export function checkPatternMatches(
  settingsDir: string,
  pattern: string,
): { matched: boolean; files: string[] } {
  if (pattern.startsWith("!")) return { matched: true, files: [] };

  const segments = pattern.split("/").filter((segment) => segment !== "");
  const firstSegment = segments[0];
  if (!firstSegment) return { matched: false, files: [] };
  if (isGlobSegment(firstSegment)) return { matched: true, files: [] };

  let currentPath = settingsDir;
  let hasMatchedSegments = false;
  for (const segment of segments) {
    if (isGlobSegment(segment)) break;
    currentPath = path.join(currentPath, segment);
    if (!pathExists(currentPath)) return { matched: false, files: [] };
    hasMatchedSegments = true;
  }

  return {
    matched: true,
    files: hasMatchedSegments ? [firstSegment] : [],
  };
}

/** @testonly */
export function checkSettingsPatterns(
  settingsDir: string,
  patterns: string[],
): Pick<
  SettingsDiagnostics,
  "matchedFiles" | "unmatchedPatterns" | "warnings"
> {
  const matchedFiles: string[] = [];
  const unmatchedPatterns: string[] = [];

  for (const pattern of patterns) {
    const normalizedPattern = normalizeSettingsPattern(pattern);
    const { matched, files } = checkPatternMatches(
      settingsDir,
      normalizedPattern,
    );
    if (matched) matchedFiles.push(...files);
    else unmatchedPatterns.push(pattern);
  }

  return { matchedFiles, unmatchedPatterns, warnings: [] };
}

export async function checkSettingsDiagnostics(): Promise<SettingsDiagnostics> {
  const config = loadTomlConfig(getGlobalConfigPath());
  const patterns = config?.settings ?? [];
  const entries = patterns.map(normalizeSettingsEntry);
  const inspection = await getSandboxSettings().inspectHost(entries);
  return {
    dirExists: inspection.directoryExists,
    patterns,
    matchedFiles: inspection.settings.map((setting) => setting.path),
    mountedFiles: inspection.settings
      .filter((setting) => setting.mode === "mount")
      .map((setting) => setting.path),
    copiedFiles: inspection.settings
      .filter((setting) => setting.mode === "copy")
      .map((setting) => setting.path),
    unmatchedPatterns: [...inspection.missingPaths],
    warnings: inspection.directoryExists
      ? []
      : [`Settings directory not found: ${inspection.directory}`],
  };
}
