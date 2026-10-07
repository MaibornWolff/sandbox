import {
  getConfigurationService,
  type PersistPath,
} from "#modules/configuration/index.js";
import { removeUnusedManagedImages } from "#modules/sandbox-images/index.js";
import {
  CACHE_VOLUME,
  getNamedVolumeName,
  removeRuntimeStorage,
} from "#modules/sandbox-resources/index.js";
import { cleanupCurrentSandboxRuntimeCache } from "#modules/sandbox-runtime/index.js";
import { getProjectPersistDir } from "#modules/storage/index.js";
import {
  getRuntimeProvider,
  type SandboxRuntime,
  type SandboxRuntimeSelection,
} from "#platform/container-runtime/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { pathExists, removeDirectory } from "#platform/filesystem/index.js";
import { getRepoRootPath } from "#platform/git/index.js";
import { getLogger } from "#platform/logging/index.js";
import { confirmDestruction } from "#platform/terminal/index.js";
import { getErrorMessage } from "#shared/errors/index.js";
import { findSandboxContainers } from "../lifecycle/container-discovery.js";
import type { CleanOptions } from "../sandbox-options.js";

/**
 * Remove containers by IDs
 */
async function removeContainers(
  service: SandboxRuntime,
  containerIds: string[],
): Promise<void> {
  const logger = getLogger();
  for (const id of containerIds) {
    try {
      await service.instances.remove(id, { force: true });
      logger.success(`Removed container: ${id.substring(0, 12)}`);
    } catch (err) {
      logger.error(`Failed to remove container ${id}: ${getErrorMessage(err)}`);
    }
  }
}

async function removeVolumes(
  runtime: SandboxRuntime,
  persistPaths: readonly PersistPath[],
): Promise<void> {
  const namedStorage = persistPaths.flatMap((persistPath) =>
    persistPath.useNamedVolume
      ? [
          {
            key: getNamedVolumeName(persistPath.useNamedVolume),
            scope: "global" as const,
          },
        ]
      : [],
  );
  const storageSpecs = [
    { key: CACHE_VOLUME, scope: "global" as const },
    ...namedStorage,
  ];
  const logger = getLogger();

  for (const spec of storageSpecs) {
    try {
      const removed = await removeRuntimeStorage(runtime, spec);
      if (removed) logger.success(`Removed volume: ${spec.key}`);
      else logger.info(`Volume ${spec.key} not found (already removed)`);
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error(`Failed to remove volume ${spec.key}: ${message}`);
    }
  }
}

/**
 * Remove persistent data directory for current project
 */
async function removePersistentData(projectRoot: string): Promise<void> {
  const persistPath = getProjectPersistDir(projectRoot);
  const logger = getLogger();

  if (pathExists(persistPath)) {
    try {
      removeDirectory(persistPath);
      logger.success(`Removed persistent data: ${persistPath}`);
    } catch (err) {
      logger.error(`Failed to remove persistent data: ${getErrorMessage(err)}`);
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
async function cleanUnusedManagedImages(
  services: SandboxRuntimeSelection,
): Promise<void> {
  const stats = await removeUnusedManagedImages(services);
  const logger = getLogger();

  if (stats.removed === 0) {
    logger.info("No unused managed images to clean");
    return;
  }

  logger.success(`Removed ${stats.removed} unused managed images`);
  logger.info(`Freed: ${stats.freedSpace}`);
}

/**
 * Main clean command with full functionality
 */
export async function cleanCommand(options: CleanOptions): Promise<void> {
  const { runtimeResolution, config, projectRoot } =
    await getConfigurationService().load(options);
  const services = await getRuntimeProvider().resolve(runtimeResolution);
  const { runtime } = services;
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
  const containers = await findSandboxContainers(runtime, { status });

  if (containers.length > 0) {
    logger.info(
      options.all
        ? "Removing all sandbox containers..."
        : "Removing stopped sandbox containers...",
    );
    await removeContainers(
      runtime,
      containers.map((container) => container.id),
    );
  } else {
    logger.info("No containers to remove");
  }

  if (options.data) {
    logger.info("Removing volumes...");
    await removeVolumes(runtime, config.persistPaths);

    logger.info("Removing persistent data...");
    await removePersistentData(projectRoot);
  }

  await cleanupCurrentSandboxRuntimeCache(runtime);
  logger.success("Cleanup complete!");
  await cleanUnusedManagedImages(services);
}
