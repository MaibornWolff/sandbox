/**
 * Central naming constants for sandbox images, containers, and volumes.
 *
 * All image, container, and volume names should be derived from these
 * constants and helpers. This ensures OCI-compliant references that
 * work across Docker and Podman runtimes.
 *
 * Old naming used "sandbox--" (double dash). New naming uses "sandbox-"
 * (single dash) to comply with the OCI distribution spec which forbids
 * consecutive special characters in repository names.
 */

/** Prefix used for all sandbox resources (images, containers, volumes). */
export const SANDBOX_PREFIX = "sandbox-";

/** Old prefix used before migration (double dash). */
export const LEGACY_PREFIX = "sandbox--";

// -- Image names ------------------------------------------------------------

/** Base layer image name (built from docker/Dockerfile in the repo). */
export const BASE_IMAGE = `${SANDBOX_PREFIX}base:latest`;

/** User layer image name (built from user-level config Dockerfile). */
export const USER_IMAGE = `${SANDBOX_PREFIX}user:latest`;

/** Legacy base image name (pre-migration). */
const LEGACY_BASE_IMAGE = `${LEGACY_PREFIX}base:latest`;

/** Legacy user image name (pre-migration). */
const LEGACY_USER_IMAGE = `${LEGACY_PREFIX}user:latest`;

// -- Volume names -----------------------------------------------------------

/** Shared cache volume mounted at /var/cache. */
export const CACHE_VOLUME = `${SANDBOX_PREFIX}cache`;

/** Legacy cache volume name (pre-migration). */
export const LEGACY_CACHE_VOLUME = `${LEGACY_PREFIX}cache`;

// -- Helpers ----------------------------------------------------------------

/** Get the Docker named volume name for a given suffix (e.g. "nix" → "sandbox-nix"). */
export function getNamedVolumeName(suffix: string): string {
  return `${SANDBOX_PREFIX}${suffix}`;
}

/**
 * Get the project image name for a given slug.
 * @param slug - The project slug (from generateProjectSlug)
 * @returns Image name like "sandbox-myproject-ab12:latest"
 */
export function getProjectImageName(slug: string): string {
  return `${SANDBOX_PREFIX}${slug}:latest`;
}

/**
 * Glob pattern that matches all sandbox images (for cleanup operations).
 * @returns Pattern like "sandbox-*"
 */
export function getSandboxImageGlob(): string {
  return `${SANDBOX_PREFIX}*`;
}

/**
 * Check if a name uses the legacy double-dash prefix.
 */
export function isLegacyName(name: string): boolean {
  return name.startsWith(LEGACY_PREFIX);
}

/**
 * Convert a legacy name to the new naming convention.
 * Replaces the first occurrence of "sandbox--" with "sandbox-".
 */
export function migrateName(name: string): string {
  if (!isLegacyName(name)) return name;
  return SANDBOX_PREFIX + name.slice(LEGACY_PREFIX.length);
}

/**
 * Replace legacy image references in Dockerfile content.
 * Returns the updated content (unchanged if no legacy references found).
 */
export function migrateDockerfileContent(content: string): string {
  return content
    .replaceAll(LEGACY_BASE_IMAGE, BASE_IMAGE)
    .replaceAll(LEGACY_USER_IMAGE, USER_IMAGE);
}
