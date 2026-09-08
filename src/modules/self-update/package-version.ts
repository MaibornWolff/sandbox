import { readPackageVersion } from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";

/** @testonly */
export function parseVersion(version: string): number[] {
  return version.split(".").map(Number);
}

export function isNewerVersion(current: string, latest: string): boolean {
  const currentParts = parseVersion(current);
  const latestParts = parseVersion(latest);

  for (
    let index = 0;
    index < Math.max(currentParts.length, latestParts.length);
    index++
  ) {
    const currentPart = currentParts[index] ?? 0;
    const latestPart = latestParts[index] ?? 0;
    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }
  return false;
}

export function getVersion(): string {
  try {
    return readPackageVersion();
  } catch {
    getLogger().warn(
      "Could not read version from package.json, using 'unknown'",
    );
    return "unknown";
  }
}
