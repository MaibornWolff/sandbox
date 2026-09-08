import path from "node:path";
import fg from "fast-glob";
import { hasGlobChars } from "#modules/configuration/index.js";
import type { Mount } from "#modules/storage/index.js";
import { exists, resolveRealPath } from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import { getSettingsDir } from "./settings-paths.js";

const CONTAINER_HOME = "/home/sandbox";

/**
 * Find symlinked entries in the settings directory that point outside.
 * These need separate mounts to resolve correctly inside the container.
 */

/**
 * Check if a path matches any exclusion pattern.
 */
function shouldExclude(filePath: string, excludePatterns: string[]): boolean {
  const basename = path.basename(filePath);
  for (const exclude of excludePatterns) {
    if (filePath === exclude || filePath.startsWith(`${exclude}/`)) {
      return true;
    }
    if (basename === exclude) {
      return true;
    }
  }
  return false;
}

/**
 * Separate patterns into include and exclude lists.
 */
function separatePatterns(patterns: string[]): {
  includePatterns: string[];
  excludePatterns: string[];
} {
  const includePatterns: string[] = [];
  const excludePatterns: string[] = [];

  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      excludePatterns.push(pattern.slice(1));
    } else {
      includePatterns.push(pattern);
    }
  }

  return { includePatterns, excludePatterns };
}

/**
 * Expand a single pattern to matching paths in the settings directory.
 * Returns empty array if nothing matches.
 */
async function expandPattern(
  settingsDir: string,
  pattern: string,
): Promise<string[]> {
  const cleanPattern = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;

  if (hasGlobChars(cleanPattern)) {
    try {
      return await fg.glob(cleanPattern, {
        cwd: settingsDir,
        dot: true,
        onlyFiles: false,
        followSymbolicLinks: true,
      });
    } catch (error) {
      getLogger().debug(`Glob "${pattern}" failed: ${error}`);
      return [];
    }
  }

  // Literal path - check existence
  if (await exists(path.join(settingsDir, cleanPattern))) {
    return [cleanPattern];
  }
  getLogger().debug(`Settings path not found: ${cleanPattern}`);
  return [];
}

/**
 * Create a mount for a matched path, resolving symlinks.
 * Returns null if the path cannot be resolved.
 */
async function createMountForMatch(
  settingsDir: string,
  match: string,
): Promise<Mount | null> {
  const hostFullPath = path.join(settingsDir, match);
  try {
    const hostPath = await resolveRealPath(hostFullPath);
    return {
      hostPath,
      containerPath: `${CONTAINER_HOME}/${match}`,
      mode: "rw",
    };
  } catch {
    getLogger().debug(`Cannot resolve real path: ${hostFullPath}`);
    return null;
  }
}

/**
 * Resolve settings patterns to individual file/directory mounts.
 * Each matched file/dir gets its own bind mount from host settings → container home.
 *
 * @param settingsDir - Absolute (resolved) path to the settings directory
 * @param patterns - Normalized patterns (~/prefix already stripped)
 * @returns Mount[] with containerPath = /home/sandbox/{relativePath}
 * @testonly
 */
export async function resolveSettingsPaths(
  settingsDir: string,
  patterns: readonly string[],
): Promise<readonly string[]> {
  const { includePatterns, excludePatterns } = separatePatterns([...patterns]);
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const pattern of includePatterns) {
    for (const match of await expandPattern(settingsDir, pattern)) {
      if (shouldExclude(match, excludePatterns)) {
        getLogger().debug(`Settings excluded: ${match}`);
        continue;
      }
      if (seen.has(match)) continue;
      seen.add(match);
      selected.push(match);
    }
  }
  return selected;
}

async function resolveSettingsToMounts(
  settingsDir: string,
  patterns: readonly string[],
): Promise<Mount[]> {
  const mounts: Mount[] = [];
  for (const match of await resolveSettingsPaths(settingsDir, patterns)) {
    const mount = await createMountForMatch(settingsDir, match);
    if (mount) mounts.push(mount);
  }
  return mounts;
}

/**
 * Get settings directory mounts for the container
 *
 * Mounts the settings directory itself (for backsync), plus separate mounts for any
 * symlinked entries that point outside the directory (e.g., Nix/Home Manager),
 * plus individual file/directory mounts resolved from the settings patterns.
 *
 * @param patterns - Normalized settings patterns (~/prefix already stripped)
 * @returns Array of mounts (empty if settings dir doesn't exist)
 */
export async function getSettingsMounts(
  patterns: string[] = [],
): Promise<Mount[]> {
  const settingsDir = getSettingsDir();

  // Check if settings directory exists
  if (!(await exists(settingsDir))) {
    getLogger().debug("Settings directory does not exist");
    return [];
  }

  // Resolve the settings directory itself (important for Nix/Home Manager)
  const resolvedSettingsDir = await resolveRealPath(settingsDir);

  const mounts: Mount[] = [];

  // Mount the settings directory itself for container-tools backsync.
  mounts.push({
    hostPath: resolvedSettingsDir,
    containerPath: "/etc/sandbox/settings",
    mode: "rw",
  });
  getLogger().debug(
    `Settings mount: ${resolvedSettingsDir} -> /etc/sandbox/settings`,
  );

  // External symlinks (pointing outside the settings dir) are included as
  // symlinks in the base mount.  We intentionally do NOT overlay-mount their
  // resolved targets because nested bind mounts (child of another bind mount)
  // are not portable across container runtimes - Podman's crun creates all
  // mount points against the image filesystem before applying any mounts,
  // so the child target does not exist yet and the mount fails.

  // Resolve patterns to individual file/directory mounts
  const patternMounts = await resolveSettingsToMounts(
    resolvedSettingsDir,
    patterns,
  );
  mounts.push(...patternMounts);

  if (patternMounts.length > 0) {
    getLogger().debug(
      `Settings pattern mounts: ${patternMounts.length} resolved from patterns`,
    );
    for (const mount of patternMounts) {
      getLogger().debug(`  ${mount.hostPath} -> ${mount.containerPath}`);
    }
  }

  return mounts;
}
