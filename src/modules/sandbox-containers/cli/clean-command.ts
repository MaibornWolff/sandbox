import {
  getConfigurationService,
  type PersistPath,
} from "#modules/configuration/index.js";
import { removeDanglingImages } from "#modules/sandbox-images/index.js";
import {
  CACHE_VOLUME,
  getNamedVolumeName,
} from "#modules/sandbox-resources/index.js";
import { cleanupCurrentSandboxRuntimeCache } from "#modules/sandbox-runtime/index.js";
import { getProjectPersistDir } from "#modules/storage/index.js";
import {
  type ContainerRuntime,
  getRuntimeProvider,
} from "#platform/container-runtime/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { pathExists, removeDirectory } from "#platform/filesystem/index.js";
import { getRepoRootPath } from "#platform/git/index.js";
import { getLogger } from "#platform/logging/index.js";
import { confirmDestruction } from "#platform/terminal/index.js";
import { findSandboxContainers } from "../lifecycle/container-discovery.js";
import type { CleanOptions } from "../sandbox-options.js";

/**
 * Remove containers by IDs
 */
async function removeContainers(
  service: ContainerRuntime,
  containerIds: string[],
): Promise<void> {
  const logger = getLogger();
  for (const id of containerIds) {
    try {
      await service.removeContainer(id, true);
      logger.success(`Removed container: ${id.substring(0, 12)}`);
    } catch (err) {
      logger.error(`Failed to remove container ${id}: ${err}`);
    }
  }
}

/**
 * Remove Docker volumes
 */
async function removeVolumes(
  service: ContainerRuntime,
  persistPaths: PersistPath[],
): Promise<void> {
  const namedVols = persistPaths
    .filter((p) => p.useNamedVolume)
    .map((p) => getNamedVolumeName(p.useNamedVolume as string));
  const volumes = [CACHE_VOLUME, ...namedVols];
  const logger = getLogger();

  for (const vol of volumes) {
    try {
      await service.removeVolume(vol);
      logger.success(`Removed volume: ${vol}`);
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      if (
        errMessage.includes("No such volume") ||
        errMessage.includes("no such volume")
      ) {
        logger.info(`Volume ${vol} not found (already removed)`);
      } else {
        logger.error(`Failed to remove volume ${vol}: ${errMessage}`);
      }
    }
  }
}

/**
 * Remove persistent data directory for current project
 */
async function removePersistentData(): Promise<void> {
  const projectRoot = await getRepoRootPath(
    getHostEnvironment().currentWorkingDirectory,
  );
  const persistPath = getProjectPersistDir(projectRoot);
  const logger = getLogger();

  if (pathExists(persistPath)) {
    try {
      removeDirectory(persistPath);
      logger.success(`Removed persistent data: ${persistPath}`);
    } catch (err) {
      logger.error(`Failed to remove persistent data: ${err}`);
    }
  } else {
    logger.info("Persistent data directory not found (already removed)");
  }
}

/**
 * Check if confirmation prompt is needed
 * @testonly
 */
export function shouldPromptForConfirmation(options: CleanOptions): boolean {
  return Boolean(options.data && !options.force);
}

/**
 * Build confirmation message
 * @testonly
 */
export async function buildConfirmationMessage(
  options: CleanOptions,
): Promise<string> {
  if (options.data) {
    const projectRoot = await getRepoRootPath(
      getHostEnvironment().currentWorkingDirectory,
    );
    const dataPath = getProjectPersistDir(projectRoot);
    return `This will delete all sandbox containers, Docker volumes, and persistent data (${dataPath}).`;
  }
  return "This will delete all sandbox containers.";
}

/**
 * Clean dangling images from previous builds
 */
async function cleanDanglingImages(service: ContainerRuntime): Promise<void> {
  const stats = await removeDanglingImages(service);
  const logger = getLogger();

  if (stats.removed === 0) {
    logger.info("No dangling images to clean");
    return;
  }

  logger.success(`Removed ${stats.removed} dangling images`);
  logger.info(`Freed: ${stats.freedSpace}`);
}

/**
 * Main clean command with full functionality
 */
export async function cleanCommand(options: CleanOptions): Promise<void> {
  const { configuredRuntime, config } =
    await getConfigurationService().load(options);
  const service = await getRuntimeProvider().resolve(configuredRuntime);
  const logger = getLogger();

  if (shouldPromptForConfirmation(options)) {
    const confirmed = await confirmDestruction(
      await buildConfirmationMessage(options),
    );
    if (!confirmed) {
      logger.info("Cancelled");
      return;
    }
  }

  const status = options.all ? "all" : "exited";
  const containers = await findSandboxContainers(service, { status });

  if (containers.length > 0) {
    logger.info(
      options.all
        ? "Removing all sandbox containers..."
        : "Removing stopped sandbox containers...",
    );
    await removeContainers(
      service,
      containers.map((container) => container.id),
    );
  } else {
    logger.info("No containers to remove");
  }

  if (options.data) {
    logger.info("Removing volumes...");
    await removeVolumes(service, config.persistPaths);

    logger.info("Removing persistent data...");
    await removePersistentData();
  }

  await cleanupCurrentSandboxRuntimeCache(service);
  logger.success("Cleanup complete!");
  await cleanDanglingImages(service);
}
