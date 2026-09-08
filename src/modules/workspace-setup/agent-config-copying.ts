import * as path from "node:path";
import { getSandboxSettings } from "#modules/sandbox-settings/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import {
  copyFile,
  createSymbolicLink,
  ensureDirectory,
  getPathType,
  isDirectoryPath,
  listDirectory,
  pathExists,
  readSymbolicLinkSync,
  removePath,
} from "#platform/filesystem/index.js";
import { AGENT_CONFIGS } from "./agent-config-catalog.js";

/**
 * Detected agent configuration
 */
export interface DetectedConfig {
  name: string;
  /** Path to display (relative to home, e.g., ".claude") */
  displayPath: string;
  /** Paths that exist and will be copied (absolute source paths) */
  sourcePaths: string[];
  /** Paths relative to home for each source path */
  relativePaths: string[];
  /** Base directory in sandbox settings */
  targetBaseDir: string;
  /** Settings file to modify for bypass (relative to home), or null */
  settingsFileRelative: string | null;
  /** Function to add bypass settings, or null */
  addBypassSettings: ((parsed: Record<string, unknown>) => void) | null;
}

/**
 * Directories/files to exclude when copying
 */
const COPY_EXCLUSIONS = new Set([
  "node_modules",
  ".git",
  ".DS_Store",
  "bun.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

/**
 * Remove existing destination if needed before copying
 */
function removeExistingDestination(
  destPath: string,
  srcIsDirectory: boolean,
): void {
  const destinationType = getPathType(destPath);
  if (destinationType === null) return;

  const destIsRealDirectory = destinationType === "directory";

  // If dest is a real directory and source is also a directory, merge (don't remove)
  if (destIsRealDirectory && srcIsDirectory) {
    return;
  }

  // Remove file, symlink, or directory when source isn't directory
  removePath(destPath);
}

/**
 * Copy a single entry (file, directory, or symlink)
 */
function copyEntry(srcPath: string, destPath: string): void {
  const sourceType = getPathType(srcPath);

  if (sourceType === "symbolic-link") {
    createSymbolicLink(readSymbolicLinkSync(srcPath), destPath);
  } else if (sourceType === "directory") {
    copyDirectoryRecursive(srcPath, destPath);
  } else if (sourceType === "file") {
    copyFile(srcPath, destPath);
  }
  // Skip other types (sockets, fifos, etc.)
}

/**
 * Recursively copy a directory
 */
function copyDirectoryRecursive(src: string, dest: string): void {
  ensureDirectory(dest);

  for (const name of listDirectory(src)) {
    if (COPY_EXCLUSIONS.has(name)) {
      continue;
    }

    const srcPath = path.join(src, name);
    const destPath = path.join(dest, name);
    const sourceType = getPathType(srcPath);

    removeExistingDestination(destPath, sourceType === "directory");
    copyEntry(srcPath, destPath);
  }
}

/**
 * Copy a file or directory to the target location
 * Preserves the path structure relative to home
 */
export function copyPath(
  sourcePath: string,
  homeDir: string,
  targetBaseDir: string,
): void {
  const relativePath = path.relative(homeDir, sourcePath);
  const targetPath = path.join(targetBaseDir, relativePath);

  if (isDirectoryPath(sourcePath)) {
    copyDirectoryRecursive(sourcePath, targetPath);
  } else {
    ensureDirectory(path.dirname(targetPath));
    copyFile(sourcePath, targetPath);
  }
}

/**
 * Check if a target path already exists in sandbox settings
 */
export function getExistingTargetPaths(config: DetectedConfig): string[] {
  const existing: string[] = [];
  for (const relativePath of config.relativePaths) {
    const targetPath = path.join(config.targetBaseDir, relativePath);
    if (pathExists(targetPath)) {
      existing.push(relativePath);
    }
  }
  return existing;
}

/**
 * Detect existing agent configurations on the system
 * Returns list of detected configs with their content
 * @param homeDir - Optional home directory override (for testing)
 */
export function detectExistingAgentConfigs(homeDir?: string): DetectedConfig[] {
  const home = homeDir ?? getHostEnvironment().homeDirectory;
  const settingsDir = getSandboxSettings().getHostDirectory();
  const detected: DetectedConfig[] = [];

  for (const configDef of AGENT_CONFIGS) {
    const existingSourcePaths: string[] = [];
    const existingRelativePaths: string[] = [];

    for (const relativePath of configDef.pathsToCopy) {
      const fullPath = path.join(home, relativePath);
      if (pathExists(fullPath)) {
        existingSourcePaths.push(fullPath);
        existingRelativePaths.push(relativePath);
      }
    }

    // Only include if at least one path exists
    if (existingSourcePaths.length === 0) {
      continue;
    }

    detected.push({
      name: configDef.name,
      displayPath: configDef.displayPath,
      sourcePaths: existingSourcePaths,
      relativePaths: existingRelativePaths,
      targetBaseDir: settingsDir,
      settingsFileRelative: configDef.settingsFile,
      addBypassSettings: configDef.addBypassSettings,
    });
  }

  return detected;
}
