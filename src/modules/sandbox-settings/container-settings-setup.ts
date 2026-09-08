import path from "node:path";
import type { SettingsEntry } from "#modules/configuration/index.js";
import type { Mount } from "#modules/storage/index.js";
import {
  exists,
  getPathType,
  listDirectory,
  readSymbolicLink,
  resolveRealPath,
} from "#platform/filesystem/index.js";
import {
  createSettingsManifest,
  serializeSettingsManifest,
} from "./settings-manifest.js";
import { getSettingsMounts } from "./settings-mount-resolution.js";
import { getSettingsDir } from "./settings-paths.js";
import { cleanStaleSettingsSymlinks } from "./stale-settings-symlink-cleanup.js";

export interface PreparedSettings {
  readonly mounts: readonly Mount[];
  readonly environment: Readonly<Record<string, string>>;
}

interface DirectMount {
  readonly containerPath: string;
  readonly mode: "ro" | "rw";
}

export interface CreateSettingsContainerSetupOptions {
  readonly entries: readonly SettingsEntry[];
  readonly persistentMounts: readonly Mount[];
  readonly directMounts?: readonly DirectMount[];
}

function destinationPath(relativePath: string): string {
  return `/home/sandbox/${relativePath.replace(/\/$/, "")}`;
}

function isPathAtOrBelow(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function assertNoDirectMountConflicts(
  copyPaths: readonly string[],
  mounts: readonly DirectMount[],
): void {
  for (const copyPath of copyPaths) {
    const destination = destinationPath(copyPath);
    for (const mount of mounts) {
      const mountPath = mount.containerPath.replace(/\/$/, "");
      if (destination === mountPath) {
        throw new Error(
          `Cannot copy setting ~/${copyPath.replace(/\/$/, "")}: destination ${destination} is a direct mount point`,
        );
      }
      if (mount.mode === "ro" && isPathAtOrBelow(destination, mountPath)) {
        throw new Error(
          `Cannot copy setting ~/${copyPath.replace(/\/$/, "")}: read-only mount ${mountPath} covers destination ${destination}`,
        );
      }
    }
  }
}

function assertNoSettingsMountConflicts(
  copyPaths: readonly string[],
  mounts: readonly Mount[],
): void {
  for (const copyPath of copyPaths) {
    const destination = destinationPath(copyPath);
    const conflict = mounts.find(
      (mount) =>
        mount.containerPath !== "/etc/sandbox/settings" &&
        isPathAtOrBelow(destination, mount.containerPath.replace(/\/$/, "")),
    );
    if (conflict) {
      throw new Error(
        `Cannot copy setting ~/${copyPath.replace(/\/$/, "")}: mount-mode setting ${conflict.containerPath} covers destination ${destination}`,
      );
    }
  }
}

async function assertSupportedLinks(
  currentPath: string,
  settingsDirectory: string,
  visited: Set<string>,
): Promise<void> {
  const type = getPathType(currentPath);
  if (type === "symbolic-link") {
    const target = await readSymbolicLink(currentPath);
    const resolvedTarget = await resolveRealPath(currentPath);
    const relativeTarget = path.relative(settingsDirectory, resolvedTarget);
    if (
      path.isAbsolute(target) ||
      relativeTarget === ".." ||
      relativeTarget.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeTarget)
    ) {
      throw new Error(
        `Cannot copy setting source ${currentPath}: symbolic link target must be relative and stay inside ${settingsDirectory}`,
      );
    }
    if (!visited.has(resolvedTarget)) {
      visited.add(resolvedTarget);
      await assertSupportedLinks(resolvedTarget, settingsDirectory, visited);
    }
    return;
  }
  if (type !== "directory") return;
  for (const entry of listDirectory(currentPath)) {
    await assertSupportedLinks(
      path.join(currentPath, entry),
      settingsDirectory,
      visited,
    );
  }
}

async function validateCopySourceLinks(
  copyPaths: readonly string[],
): Promise<void> {
  const settingsDirectory = getSettingsDir();
  for (const copyPath of copyPaths) {
    const sourcePath = path.join(
      settingsDirectory,
      copyPath.replace(/\/$/, ""),
    );
    if (await exists(sourcePath)) {
      await assertSupportedLinks(
        sourcePath,
        settingsDirectory,
        new Set([sourcePath]),
      );
    }
  }
}

export async function createContainerSettingsSetup(
  options: CreateSettingsContainerSetupOptions,
): Promise<PreparedSettings> {
  const mountPaths = options.entries
    .filter((entry) => entry.mode === "mount")
    .map((entry) => entry.path);
  const copyPaths = options.entries
    .filter((entry) => entry.mode === "copy")
    .map((entry) => entry.path);
  assertNoDirectMountConflicts(copyPaths, [
    ...options.persistentMounts,
    ...(options.directMounts ?? []),
  ]);
  await validateCopySourceLinks(copyPaths);

  const mounts = await getSettingsMounts(mountPaths);
  assertNoSettingsMountConflicts(copyPaths, mounts);
  await cleanStaleSettingsSymlinks([...options.persistentMounts], mountPaths);
  const manifest = createSettingsManifest({ mountPaths, copyPaths });
  return {
    mounts,
    environment: {
      SANDBOX_SETTINGS: serializeSettingsManifest(manifest),
    },
  };
}
