const SANDBOX_PREFIX = "sandbox-";

export const BASE_IMAGE = `${SANDBOX_PREFIX}base:latest`;
export const USER_IMAGE = `${SANDBOX_PREFIX}user:latest`;
export const CACHE_VOLUME = `${SANDBOX_PREFIX}cache`;

// Versions before the OCI-compliant naming used a double-dash prefix.
const LEGACY_IMAGE_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ["sandbox--base:latest", BASE_IMAGE],
  ["sandbox--user:latest", USER_IMAGE],
];

export function getNamedVolumeName(suffix: string): string {
  return `${SANDBOX_PREFIX}${suffix}`;
}

export function getProjectImageName(slug: string): string {
  return `${SANDBOX_PREFIX}${slug}:latest`;
}

export function replaceLegacyImageReferences(content: string): string {
  return LEGACY_IMAGE_REPLACEMENTS.reduce(
    (updated, [legacy, current]) => updated.replaceAll(legacy, current),
    content,
  );
}
