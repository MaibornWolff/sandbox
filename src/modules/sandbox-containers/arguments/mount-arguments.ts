import { getLogger } from "#platform/logging/index.js";

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

export function logCustomMounts(mounts: string[], label: string): void {
  if (mounts.length === 0) return;
  const logger = getLogger();
  logger.debug(`${label} (${mounts.length}):`);
  for (const mount of mounts) logger.debug(`  ${mount}`);
}
