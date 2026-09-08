import crypto from "node:crypto";
import { normalizePath, safeResolve } from "./path.js";

/**
 * Generate a unique, human-readable slug for a project
 * Combines sanitized path components with a hash for uniqueness
 *
 * @param projectRoot - The resolved project/repo root path
 * @returns A slug in the format: {sanitized-name}-{hash} (max 63 chars)
 */
export function generateProjectSlug(projectRoot: string): string {
  // 1. Resolve to absolute path and normalize separators
  const repoRoot = normalizePath(safeResolve(projectRoot));
  // 2. Extract meaningful path component (last 1-2 directory names)
  const pathComponent = extractPathComponent(repoRoot);
  // 3. Sanitize to slug format
  const sanitized = sanitizePathToSlug(pathComponent);
  // 4. Hash full path and append 4 chars for uniqueness
  const hash = hashPath(repoRoot);
  // 5. Combine and ensure max 63 chars (Docker compatibility)
  const slug = `${sanitized}-${hash}`;
  return slug.substring(0, 63);
}

/**
 * Extract meaningful path components for readability
 * Takes the last 1-2 directory names from the path
 *
 * @param absolutePath - The absolute path to extract from
 * @returns Combined directory names
 */
function extractPathComponent(absolutePath: string): string {
  const parts = absolutePath.split("/").filter(Boolean);
  return parts.slice(-2).join("-");
}

/**
 * Sanitize path component to valid slug format
 * Converts to lowercase, replaces non-alphanumeric with dashes
 *
 * @param pathComponent - The path component to sanitize
 * @returns Sanitized slug string
 */
function sanitizePathToSlug(pathComponent: string): string {
  return (
    pathComponent
      .toLowerCase()
      // Replace non-alphanumeric with dashes
      .replace(/[^a-z0-9]+/g, "-")
      // Collapse multiple dashes
      .replace(/-+/g, "-")
      // Trim dashes from ends
      .replace(/^-|-$/g, "")
  );
}

/**
 * Generate a short hash from the absolute path for uniqueness
 *
 * @param absolutePath - The absolute path to hash
 * @returns 4-character hex hash
 */
function hashPath(absolutePath: string): string {
  return crypto
    .createHash("sha256")
    .update(absolutePath)
    .digest("hex")
    .substring(0, 4);
}
