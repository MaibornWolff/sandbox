const SANDBOX_PREFIX = "sandbox-";

export const BASE_IMAGE = `${SANDBOX_PREFIX}base:latest`;
export const USER_IMAGE = `${SANDBOX_PREFIX}user:latest`;
export const CACHE_VOLUME = `${SANDBOX_PREFIX}cache`;

export function getNamedVolumeName(suffix: string): string {
  return `${SANDBOX_PREFIX}${suffix}`;
}

export function getProjectImageName(slug: string): string {
  return `${SANDBOX_PREFIX}${slug}:latest`;
}
