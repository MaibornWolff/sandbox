import chalk from "chalk";
import {
  getGlobalDockerfilePath,
  getProjectDockerfilePath,
} from "#modules/configuration/index.js";
import type { ContainerRuntime } from "#platform/container-runtime/index.js";
import {
  pathExists,
  readTextFile,
  writeTextFile,
} from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import {
  CACHE_VOLUME,
  isLegacyName,
  LEGACY_CACHE_VOLUME,
  LEGACY_PREFIX,
  migrateDockerfileContent,
  migrateName,
  SANDBOX_PREFIX,
} from "./resource-naming.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

interface MigrationResult {
  imagesRetagged: number;
  volumeMigrated: boolean;
  containersRemoved: number;
  dockerfilesMigrated: number;
}

// ---------------------------------------------------------------------------
// Fast detection
// ---------------------------------------------------------------------------

/**
 * Return the two Dockerfile paths that may contain legacy image references.
 */
function getDockerfilePaths(projectRoot: string): string[] {
  return [getGlobalDockerfilePath(), getProjectDockerfilePath(projectRoot)];
}

/**
 * Quick check: do any of the Dockerfiles still reference the legacy prefix?
 * Only reads files - no container runtime calls.
 */
function hasLegacyDockerfiles(projectRoot: string): boolean {
  for (const filePath of getDockerfilePaths(projectRoot)) {
    if (!pathExists(filePath)) continue;
    const content = readTextFile(filePath);
    if (content.includes(LEGACY_PREFIX)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Individual migration steps
// ---------------------------------------------------------------------------

/**
 * Rewrite legacy image references in a single Dockerfile.
 * Returns true if the file was modified.
 */
function migrateDockerfile(filePath: string): boolean {
  if (!pathExists(filePath)) return false;

  const content = readTextFile(filePath);
  const updated = migrateDockerfileContent(content);

  if (updated === content) return false;

  writeTextFile(filePath, updated);
  return true;
}

/**
 * Find all sandbox images using the legacy naming and retag them.
 */
async function migrateImages(service: ContainerRuntime): Promise<number> {
  let count = 0;
  const logger = getLogger();

  let images: string[];
  try {
    images = (await service.listImageReferences()).filter((line) =>
      isLegacyName(line),
    );
  } catch {
    return 0;
  }

  for (const oldName of images) {
    const newName = migrateName(oldName);
    try {
      logger.info(
        `Retagging image: ${chalk.cyan(oldName)} -> ${chalk.cyan(newName)}`,
      );
      await service.tagImage(oldName, newName);
      await service.removeImage(oldName);
      count++;
    } catch (err) {
      logger.warn(`Failed to retag ${chalk.cyan(oldName)}: ${err}`);
    }
  }

  return count;
}

/**
 * Migrate the legacy cache volume by creating a new one and copying data.
 * Docker does not support renaming volumes, so we create + copy + remove.
 */
async function migrateVolume(service: ContainerRuntime): Promise<boolean> {
  const logger = getLogger();
  if (!(await service.volumeExists(LEGACY_CACHE_VOLUME))) {
    return false;
  }

  // If the new volume already exists just drop the old one
  if (await service.volumeExists(CACHE_VOLUME)) {
    logger.info(
      `Volume ${chalk.cyan(CACHE_VOLUME)} already exists, removing legacy volume`,
    );
    try {
      await service.removeVolume(LEGACY_CACHE_VOLUME);
    } catch {
      logger.warn(
        `Could not remove legacy volume ${chalk.cyan(LEGACY_CACHE_VOLUME)}`,
      );
    }
    return true;
  }

  logger.info(
    `Migrating volume: ${chalk.cyan(LEGACY_CACHE_VOLUME)} -> ${chalk.cyan(CACHE_VOLUME)}`,
  );

  try {
    await service.createVolume(CACHE_VOLUME);
    await service.copyVolume(LEGACY_CACHE_VOLUME, CACHE_VOLUME);
    await service.removeVolume(LEGACY_CACHE_VOLUME);
    return true;
  } catch (err) {
    logger.warn(`Failed to migrate volume: ${err}`);
    try {
      await service.removeVolume(CACHE_VOLUME);
    } catch {
      // ignore
    }
    return false;
  }
}

/**
 * Stop and remove containers with legacy names so they get recreated
 * with the new naming on next run.
 */
async function migrateContainers(service: ContainerRuntime): Promise<number> {
  let count = 0;
  const logger = getLogger();

  try {
    const containers = await service.listContainers({ all: true });

    for (const container of containers) {
      if (!isLegacyName(container.name)) continue;

      try {
        logger.info(`Removing legacy container: ${chalk.cyan(container.name)}`);
        await service.removeContainer(container.id, true);
        count++;
      } catch (err) {
        logger.warn(
          `Failed to remove container ${chalk.cyan(container.name)}: ${err}`,
        );
      }
    }
  } catch {
    // listContainers failed, skip container migration
  }

  return count;
}

// ---------------------------------------------------------------------------
// Full migration
// ---------------------------------------------------------------------------

/**
 * Run the complete migration: images, volumes, containers, and Dockerfiles.
 * Returns a summary of what changed.
 */
export async function runFullMigration(
  service: ContainerRuntime,
  projectRoot: string,
): Promise<MigrationResult> {
  const imagesRetagged = await migrateImages(service);
  const volumeMigrated = await migrateVolume(service);
  const containersRemoved = await migrateContainers(service);

  let dockerfilesMigrated = 0;
  const logger = getLogger();
  for (const filePath of getDockerfilePaths(projectRoot)) {
    if (migrateDockerfile(filePath)) {
      logger.info(`Migrated Dockerfile: ${chalk.dim(filePath)}`);
      dockerfilesMigrated++;
    }
  }

  return {
    imagesRetagged,
    volumeMigrated,
    containersRemoved,
    dockerfilesMigrated,
  };
}

/**
 * Auto-migration hook called before building images.
 *
 * Fast path: reads the two Dockerfiles and checks for the legacy prefix.
 * If no legacy references are found, returns immediately with no runtime calls.
 * When legacy references are detected, runs the full migration (images,
 * volumes, containers, Dockerfiles).
 */
export async function autoMigrateLegacyResources(
  service: ContainerRuntime,
  projectRoot: string,
): Promise<void> {
  if (!hasLegacyDockerfiles(projectRoot)) return;

  const logger = getLogger();
  logger.info(
    `Detected legacy ${chalk.cyan(LEGACY_PREFIX)} naming in Dockerfiles, migrating to ${chalk.cyan(SANDBOX_PREFIX)}...`,
  );
  const result = await runFullMigration(service, projectRoot);

  const parts: string[] = [];
  if (result.imagesRetagged > 0)
    parts.push(`${result.imagesRetagged} image(s) retagged`);
  if (result.volumeMigrated) parts.push("cache volume migrated");
  if (result.containersRemoved > 0)
    parts.push(`${result.containersRemoved} container(s) removed`);
  if (result.dockerfilesMigrated > 0)
    parts.push(`${result.dockerfilesMigrated} Dockerfile(s) updated`);

  if (parts.length > 0) {
    logger.success(`Auto-migration complete: ${parts.join(", ")}`);
  }
}
