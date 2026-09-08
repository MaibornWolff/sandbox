/**
 * Cross-platform path utilities
 *
 * Centralizes Windows path handling to avoid scattered platform checks.
 * In Git Bash/MSYS on Windows, Node.js path functions don't recognize
 * Windows drive paths (C:/...) as absolute, causing bugs.
 */

import * as path from "node:path";

/**
 * Result of parsing a Windows drive path
 */
interface WindowsDrivePath {
  /** Lowercase drive letter (e.g., "c") */
  driveLetter: string;
  /** Path after the drive prefix, normalized to forward slashes */
  pathAfterDrive: string;
}

/**
 * Normalize path separators to forward slashes.
 *
 * Ensures consistent path representation across platforms.
 * Node.js fs APIs accept forward slashes on all platforms.
 *
 * @example
 * normalizePath("C:\\Users\\foo")    // "C:/Users/foo"
 * normalizePath("C:/Users/foo")      // "C:/Users/foo" (unchanged)
 * normalizePath("/unix/path")        // "/unix/path" (unchanged)
 * normalizePath("relative\\path")    // "relative/path"
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Check if a path starts with a Windows drive letter (C:\ or C:/)
 *
 * @example
 * isWindowsDrivePath("C:\\Users\\foo")  // true
 * isWindowsDrivePath("C:/Users/foo")    // true
 * isWindowsDrivePath("/unix/path")      // false
 */
export function isWindowsDrivePath(p: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(p);
}

/**
 * Parse a Windows drive path into its components
 *
 * @example
 * parseWindowsDrivePath("C:\\Users\\foo")  // { driveLetter: "c", pathAfterDrive: "Users/foo" }
 * parseWindowsDrivePath("C:/Users/foo")    // { driveLetter: "c", pathAfterDrive: "Users/foo" }
 * parseWindowsDrivePath("/unix/path")      // null
 * @testonly
 */
export function parseWindowsDrivePath(p: string): WindowsDrivePath | null {
  const match = p.match(/^([A-Za-z]):[/\\](.*)/);
  if (!match?.[1]) return null;

  return {
    driveLetter: match[1].toLowerCase(),
    pathAfterDrive: (match[2] || "").replace(/\\/g, "/"),
  };
}

/**
 * Convert a Windows path to Docker-compatible WSL mount format (/mnt/c/path)
 *
 * On non-Windows input (Unix paths), returns the path unchanged.
 * Safe to call unconditionally on any platform.
 *
 * @example
 * windowsPathToDocker("C:\\Users\\foo")  // "/mnt/c/Users/foo"
 * windowsPathToDocker("C:/Users/foo")    // "/mnt/c/Users/foo"
 * windowsPathToDocker("/unix/path")      // "/unix/path"
 */
export function windowsPathToDocker(p: string): string {
  const parsed = parseWindowsDrivePath(p);
  if (parsed) {
    return `/mnt/${parsed.driveLetter}/${parsed.pathAfterDrive}`;
  }
  return p.replace(/\\/g, "/");
}

/**
 * Check if a path is absolute (handles Windows drive paths in Git Bash)
 *
 * Node.js `path.isAbsolute()` returns false for "C:/Users/..." in Git Bash,
 * so we also check for Windows drive letter patterns.
 *
 * @example
 * isAbsolutePath("/unix/path")      // true
 * isAbsolutePath("C:/Users/foo")    // true (even in Git Bash!)
 * isAbsolutePath("C:\\Users\\foo")  // true
 * isAbsolutePath("./relative")      // false
 */
/** @testonly */
export function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p) || isWindowsDrivePath(p);
}

/**
 * Safely resolve a path, handling Windows drive paths in Git Bash
 *
 * If the target path is already absolute (including Windows drive paths),
 * returns it normalized. Otherwise resolves relative to basePath or cwd.
 *
 * @example
 * safeResolve("C:/Users/foo")              // "C:/Users/foo" (preserved)
 * safeResolve("C:/Users/foo/")             // "C:/Users/foo" (trailing slash removed)
 * safeResolve("./data", "/project")        // "/project/data"
 * safeResolve("../up", "C:/project")       // Resolved relative to C:/project
 */
export function safeResolve(targetPath: string, basePath?: string): string {
  if (isAbsolutePath(targetPath)) {
    // Normalize trailing slashes for consistency with path.resolve behavior
    return targetPath.replace(/[/\\]+$/, "");
  }
  return basePath
    ? path.resolve(basePath, targetPath)
    : path.resolve(targetPath);
}
