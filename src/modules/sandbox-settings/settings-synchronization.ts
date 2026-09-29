import path from "node:path";
import fg from "fast-glob";
import { getSandboxEnvironment } from "#platform/environment/index.js";
import {
  copyPathFollowingLinks,
  ensureDirectory,
  pathExists,
} from "#platform/filesystem/index.js";
import {
  writeStandardError,
  writeStandardOutput,
} from "#platform/terminal/index.js";
import { getErrorMessage } from "#shared/errors/index.js";
import { parseSettingsManifest } from "./settings-manifest.js";

function normalizeHomePattern(pattern: string): string {
  const isExclusion = pattern.startsWith("!");
  const prefix = isExclusion ? "!" : "";
  const candidate = isExclusion ? pattern.slice(1) : pattern;

  if (candidate === "~") return `${prefix}.`;
  if (candidate.startsWith("~/")) return `${prefix}${candidate.slice(2)}`;
  return pattern;
}

function debug(message: string): void {
  if (getSandboxEnvironment().variables.SANDBOX_DEBUG) {
    writeStandardError(`[settings] ${message}\n`);
  }
}

export async function syncNewContainerSettings(): Promise<readonly string[]> {
  const environment = getSandboxEnvironment();
  const homeDirectory = environment.homeDirectory;
  const settingsDirectory = path.join(
    environment.filesystemRoot,
    "etc",
    "sandbox",
    "settings",
  );
  const configuredPatterns = parseSettingsManifest(
    environment.variables.SANDBOX_SETTINGS,
  ).mountPaths;
  if (configuredPatterns.length === 0 || !pathExists(settingsDirectory))
    return [];

  const patterns = configuredPatterns
    .map((pattern) => (pattern.endsWith("/") ? pattern.slice(0, -1) : pattern))
    .map(normalizeHomePattern)
    .filter(Boolean);
  const matches = await fg([...patterns], {
    cwd: homeDirectory,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: true,
    unique: true,
  });
  const synced: string[] = [];
  const failures: string[] = [];

  for (const relativePath of matches) {
    const sourcePath = path.join(homeDirectory, relativePath);
    const destinationPath = path.join(settingsDirectory, relativePath);
    if (!pathExists(sourcePath) || pathExists(destinationPath)) continue;
    try {
      ensureDirectory(path.dirname(destinationPath));
      copyPathFollowingLinks(sourcePath, destinationPath);
      synced.push(relativePath);
      debug(`synced: ${relativePath}`);
      writeStandardOutput(`→ Synced ~/${relativePath} to host`);
    } catch (error) {
      const detail = getErrorMessage(error);
      failures.push(`${relativePath}: ${detail}`);
      debug(`failed to sync ${relativePath}: ${detail}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to sync settings:\n- ${failures.join("\n- ")}`);
  }
  return synced;
}
