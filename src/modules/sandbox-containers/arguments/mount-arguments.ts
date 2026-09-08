import type { Config } from "#modules/configuration/index.js";
import { getNamedVolumeName } from "#modules/sandbox-resources/index.js";
import {
  mountToDockerArg,
  type PersistentMountsResult,
} from "#modules/storage/index.js";
import { getLogger } from "#platform/logging/index.js";
import { resolveContainerPath } from "#shared/text/index.js";

export function logMounts(
  mounts: Array<{ hostPath: string; containerPath: string; mode: string }>,
  label: string,
): void {
  if (mounts.length === 0) return;
  const logger = getLogger();
  logger.debug(`${label} (${mounts.length}):`);
  for (const mount of mounts) {
    logger.debug(
      `  ${mount.hostPath} → ${mount.containerPath} (${mount.mode})`,
    );
  }
}

export function addNamedVolumeMounts(args: string[], config: Config): void {
  const logger = getLogger();
  for (const persistPath of config.persistPaths) {
    if (!persistPath.useNamedVolume) continue;
    const volumeName = getNamedVolumeName(persistPath.useNamedVolume);
    const containerPath = resolveContainerPath(
      persistPath.path,
      "/home/sandbox",
    );
    args.push("-v", `${volumeName}:${containerPath}`);
    logger.debug(`Named volume: ${volumeName}:${containerPath}`);
  }
}

export function addPersistMounts(
  args: string[],
  persistentResult: PersistentMountsResult,
): void {
  logMounts(persistentResult.mounts, "Persistent mounts");
  for (const mount of persistentResult.mounts) {
    args.push("-v", mountToDockerArg(mount));
  }
}

export function logCustomMounts(mounts: string[], label: string): void {
  if (mounts.length === 0) return;
  const logger = getLogger();
  logger.debug(`${label} (${mounts.length}):`);
  for (const mount of mounts) logger.debug(`  ${mount}`);
}
