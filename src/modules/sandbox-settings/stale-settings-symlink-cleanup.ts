import path from "node:path";
import { hasGlobChars } from "#modules/configuration/index.js";
import type { Mount } from "#modules/storage/index.js";
import {
  isSymbolicLink,
  readSymbolicLink,
  removeFile,
} from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";

const CONTAINER_HOME = "/home/sandbox";
const STALE_SYMLINK_TARGET_PREFIX = "/etc/sandbox/settings/";

export async function cleanStaleSettingsSymlinks(
  persistMounts: Mount[],
  settingsPatterns: string[],
): Promise<void> {
  const patterns = settingsPatterns
    .filter((pattern) => !pattern.startsWith("!") && !hasGlobChars(pattern))
    .map((pattern) => (pattern.endsWith("/") ? pattern.slice(0, -1) : pattern));

  for (const pattern of patterns) {
    const containerTarget = `${CONTAINER_HOME}/${pattern}`;
    const mount = persistMounts.find(
      (candidate) =>
        containerTarget.startsWith(`${candidate.containerPath}/`) ||
        containerTarget === candidate.containerPath,
    );
    if (!mount) continue;

    const relativePath = containerTarget.slice(mount.containerPath.length + 1);
    const hostPath = relativePath
      ? path.join(mount.hostPath, relativePath)
      : mount.hostPath;
    if (!(await isSymbolicLink(hostPath))) continue;

    const linkTarget = await readSymbolicLink(hostPath);
    if (linkTarget.startsWith(STALE_SYMLINK_TARGET_PREFIX)) {
      await removeFile(hostPath);
      getLogger().debug(
        `Migration: removed stale settings symlink: ${hostPath} -> ${linkTarget}`,
      );
    }
  }
}
