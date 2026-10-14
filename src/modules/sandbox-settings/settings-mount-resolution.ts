import path from "node:path";
import fg from "fast-glob";
import { hasGlobChars } from "#modules/configuration/index.js";
import type { Mount } from "#modules/storage/index.js";
import { exists, resolveRealPath } from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import { getErrorMessage } from "#shared/errors/index.js";
import { isPathInside } from "#shared/text/index.js";
import {
  createSettingsLinkEscapeError,
  type SettingsMatch,
} from "./settings-link-escape-error.js";
import { getSettingsDir } from "./settings-paths.js";

const CONTAINER_HOME = "/home/sandbox";

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
        followSymbolicLinks: false,
      });
    } catch (error) {
      getLogger().debug(`Glob "${pattern}" failed: ${getErrorMessage(error)}`);
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
 * Resolve all links in a matched path.
 * Returns null if the path cannot be resolved.
 */
async function resolveMatchRealPath(
  settingsDir: string,
  match: string,
): Promise<string | null> {
  const hostFullPath = path.join(settingsDir, match);
  try {
    return await resolveRealPath(hostFullPath);
  } catch {
    getLogger().debug(`Cannot resolve real path: ${hostFullPath}`);
    return null;
  }
}

/**
 * Select matched paths in the settings directory together with the pattern
 * that selected each path first.
 */
async function selectSettingsMatches(
  settingsDir: string,
  patterns: readonly string[],
): Promise<SettingsMatch[]> {
  const { includePatterns, excludePatterns } = separatePatterns([...patterns]);
  const seen = new Set<string>();
  const selected: SettingsMatch[] = [];
  for (const pattern of includePatterns) {
    for (const match of await expandPattern(settingsDir, pattern)) {
      if (shouldExclude(match, excludePatterns)) {
        getLogger().debug(`Settings excluded: ${match}`);
        continue;
      }
      if (seen.has(match)) continue;
      seen.add(match);
      selected.push({ path: match, pattern });
    }
  }
  return selected;
}

/**
 * Resolve settings patterns to matched relative paths.
 *
 * @param settingsDir - Absolute (resolved) path to the settings directory
 * @param patterns - Normalized patterns (~/prefix already stripped)
 */
export async function resolveSettingsPaths(
  settingsDir: string,
  patterns: readonly string[],
): Promise<readonly string[]> {
  const matches = await selectSettingsMatches(settingsDir, patterns);
  return matches.map((match) => match.path);
}

/**
 * Resolve matches to bind mounts with link-free host paths.
 * A container can write the settings directory, so a link that leaves it
 * would let the container select any host path as a read-write mount source.
 * Throws one error for all matches that resolve outside the directory.
 */
async function resolveSettingsToMounts(
  settingsDir: string,
  patterns: readonly string[],
): Promise<Mount[]> {
  const mounts: Mount[] = [];
  const escapingMatches: SettingsMatch[] = [];
  for (const match of await selectSettingsMatches(settingsDir, patterns)) {
    const hostPath = await resolveMatchRealPath(settingsDir, match.path);
    if (hostPath === null) continue;
    if (!isPathInside(hostPath, settingsDir)) {
      getLogger().debug(
        `Rejected settings path ${match.path}: resolves to ${hostPath} outside ${settingsDir}`,
      );
      escapingMatches.push(match);
      continue;
    }
    mounts.push({
      hostPath,
      containerPath: `${CONTAINER_HOME}/${match.path}`,
      mode: "rw",
    });
  }
  if (escapingMatches.length > 0) {
    throw createSettingsLinkEscapeError(settingsDir, escapingMatches);
  }
  return mounts;
}

/**
 * Get settings directory mounts for the container
 *
 * Mounts the settings directory itself (for backsync), plus individual
 * file/directory mounts resolved from the settings patterns.
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
