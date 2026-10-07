import fg from "fast-glob";
import { getLogger } from "#platform/logging/index.js";

import { getErrorMessage } from "#shared/errors/index.js";

/**
 * Directories to not recurse INTO (but can still match them).
 * These are common heavy directories that would slow down glob traversal.
 *
 * Uses `**\/X\/**\/*` pattern (not `**\/X\/**`) because fast-glob's ignore
 * applies to results too, not just traversal. The `\/*` suffix ensures
 * we only ignore contents, not the directories themselves.
 * @testonly
 */
export const GLOB_IGNORE_PATTERNS = [
  "**/node_modules/**/*",
  "**/.git/**/*",
  "**/.venv/**/*",
  "**/vendor/**/*",
  "**/dist/**/*",
  "**/build/**/*",
  "**/.next/**/*",
  "**/target/**/*",
];

interface ExpandGlobOptions {
  cwd: string;
  pattern: string; // e.g., "./**/node_modules"
}

/**
 * Expand a glob pattern to matching directory paths.
 *
 * Performance optimizations:
 * - Don't recurse into common heavy directories (node_modules, .git, etc.)
 * - Filter nested paths to avoid redundant matches
 *
 * @returns Array of matched paths with ./ prefix (e.g., ["./apps/node_modules"])
 */
export async function expandGlob(opts: ExpandGlobOptions): Promise<string[]> {
  const { cwd, pattern } = opts;
  const logger = getLogger();

  // Convert ./pattern to pattern for fast-glob (expects relative without ./)
  const globPattern = pattern.startsWith("./") ? pattern.slice(2) : pattern;

  // Handle edge case: empty pattern after stripping ./
  if (!globPattern) {
    logger.debug(`Glob "${pattern}" is empty after normalization, skipping`);
    return [];
  }

  logger.startTiming(`Glob expand: ${pattern}`);

  let rawMatches: string[];
  try {
    rawMatches = await fg.glob(globPattern, {
      cwd,
      onlyDirectories: true,
      dot: true,
      followSymbolicLinks: false,
      ignore: GLOB_IGNORE_PATTERNS,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    logger.warn(`Glob "${pattern}" failed: ${message}`);
    logger.endTiming(`Glob expand: ${pattern}`);
    return [];
  }

  // Filter out nested matches (e.g., if both a/ and a/b/ match, keep only a/)
  const matches = filterNestedPaths(rawMatches);

  logger.endTiming(`Glob expand: ${pattern}`);
  logger.debug(`Glob "${pattern}" matched ${matches.length} paths`);

  // Convert back to ./relative format
  return matches.map((m) => `./${m}`);
}

/**
 * Filter out paths that are children of other paths in the list.
 *
 * @example
 * filterNestedPaths(['a', 'a/b', 'c']) // => ['a', 'c']
 * @testonly
 */
export function filterNestedPaths(paths: string[]): string[] {
  if (paths.length <= 1) return paths;

  // Sort by length (shortest first)
  const sorted = [...paths].sort((a, b) => a.length - b.length);
  const result: string[] = [];

  for (const p of sorted) {
    const isNested = result.some((parent) => p.startsWith(`${parent}/`));
    if (!isNested) {
      result.push(p);
    }
  }

  return result;
}
