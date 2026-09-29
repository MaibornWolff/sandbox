import chalk from "chalk";
import { getClock } from "#platform/clock/index.js";
import type { ContainerRuntime } from "#platform/container-runtime/index.js";
import { buildSessionIdleCommand } from "#platform/container-system/index.js";
import { getLogger } from "#platform/logging/index.js";
import { getErrorMessage } from "#shared/errors/index.js";
import { SANDBOX_HASH_LABEL } from "../container-hashing.js";
import { SANDBOX_PROJECT_LABEL } from "../container-labels.js";
import { getContainerBaseName } from "../container-naming.js";
import { findAvailableName } from "./container-discovery.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FindOrCreateContainerResult {
  containerName: string;
  created: boolean;
}

const NAME_CONFLICT_RETRY_TIMEOUT_MS = 10_000;
const NAME_CONFLICT_RETRY_DELAY_MS = 250;

function getCreateContainerExtraArgs(
  containerArgs: string[],
  imageName: string,
): string[] {
  return containerArgs.at(-1) === imageName
    ? containerArgs.slice(0, -1)
    : containerArgs;
}

// ---------------------------------------------------------------------------
// Container discovery
// ---------------------------------------------------------------------------

interface RunningContainer {
  id: string;
  name: string;
  hash: string | null;
}

/**
 * Query running containers for a project slug and read their hashes.
 */
async function queryRunningContainers(
  service: ContainerRuntime,
  projectSlug: string,
): Promise<RunningContainer[]> {
  try {
    const entries = await service.listContainers({
      labelFilter: `${SANDBOX_PROJECT_LABEL}=${projectSlug}`,
      statusFilter: ["running"],
      labelKeys: [SANDBOX_HASH_LABEL],
    });

    return entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      hash: entry.labels?.[SANDBOX_HASH_LABEL] || null,
    }));
  } catch (error) {
    getLogger().warn(
      `Could not list running containers for ${chalk.cyan(projectSlug)}: ${getErrorMessage(error)}`,
    );
    return [];
  }
}

/**
 * Remove stopped and dead containers for a project slug (defensive cleanup).
 * A container in the created state can belong to a concurrent startup.
 */
async function removeStoppedContainers(
  service: ContainerRuntime,
  projectSlug: string,
): Promise<void> {
  const logger = getLogger();
  try {
    const entries = await service.listContainers({
      all: true,
      labelFilter: `${SANDBOX_PROJECT_LABEL}=${projectSlug}`,
      statusFilter: ["exited", "dead"],
    });

    for (const entry of entries) {
      try {
        await service.removeContainer(entry.id, true);
        logger.debug(`Removed stopped container: ${entry.id}`);
      } catch (error) {
        logger.debug(
          `Could not remove stopped container ${entry.id}, it may already be gone: ${getErrorMessage(error)}`,
        );
      }
    }
  } catch (error) {
    logger.warn(
      `Could not list stopped containers for ${chalk.cyan(projectSlug)}: ${getErrorMessage(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Container naming
// ---------------------------------------------------------------------------

/**
 * Find the next available container name for a project.
 * Base name = `sandbox-{slug}`, then `-2`, `-3`, etc.
 */
function pickContainerName(slug: string, takenNames: Set<string>): string {
  return findAvailableName(getContainerBaseName(slug), takenNames);
}

async function removeIdleObsoleteContainer(
  service: ContainerRuntime,
  container: RunningContainer,
  expectedHash: string,
): Promise<RunningContainer | null> {
  if (container.hash === expectedHash) return container;
  const logger = getLogger();
  if (!(await isContainerIdle(service, container.id))) {
    logger.debug(
      `Container ${container.name} has a different hash (${container.hash}) and active sessions, leaving it running`,
    );
    return container;
  }
  try {
    await service.removeContainer(container.id, true);
    logger.debug(`Removed idle obsolete container: ${container.name}`);
    return null;
  } catch (error) {
    const message = getErrorMessage(error);
    logger.warn(
      `Could not remove idle obsolete container ${container.name}: ${message}`,
    );
    return container;
  }
}

async function removeIdleObsoleteContainers(
  service: ContainerRuntime,
  containers: RunningContainer[],
  expectedHash: string,
): Promise<RunningContainer[]> {
  const retained = await Promise.all(
    containers.map((container) =>
      removeIdleObsoleteContainer(service, container, expectedHash),
    ),
  );
  return retained.filter(
    (container): container is RunningContainer => container !== null,
  );
}

// ---------------------------------------------------------------------------
// Readiness polling
// ---------------------------------------------------------------------------

/** Check if a docker exec error indicates the container has stopped/crashed. */
function isContainerGone(errMessage: string): boolean {
  const lower = errMessage.toLowerCase();
  return (
    lower.includes("no such container") ||
    lower.includes("is not running") ||
    lower.includes("is restarting") ||
    lower.includes("is dead")
  );
}

async function hasContainerCrashed(
  service: ContainerRuntime,
  containerName: string,
  errorMessage: string,
): Promise<boolean> {
  if (isContainerGone(errorMessage)) return true;
  try {
    return (await service.getContainerState(containerName)) !== "running";
  } catch (error) {
    getLogger().debug(
      `Could not read state of ${chalk.cyan(containerName)}, assuming it crashed: ${getErrorMessage(error)}`,
    );
    return true;
  }
}

/** Try to dump container logs for debugging; best-effort (container may be gone). */
async function dumpContainerLogs(
  service: ContainerRuntime,
  containerName: string,
): Promise<void> {
  const logger = getLogger();
  try {
    const status = await service.getContainerState(containerName);
    logger.error(`Container status: ${status}`);
  } catch {
    logger.error(
      "Container no longer exists (likely crashed and was removed by --rm)",
    );
  }
  try {
    const logs = await service.getContainerLogs(containerName, 50);
    logger.error(`Container logs:\n${logs}`);
  } catch {
    logger.error(
      "Could not fetch container logs (container may have been removed)",
    );
  }
}

/**
 * Wait for the container's entrypoint to signal readiness.
 * Uses one bounded runtime request to wait for the container ready marker.
 * Detects container crashes and dumps logs for debugging.
 */
export async function waitForReady(
  service: ContainerRuntime,
  containerName: string,
  timeoutMs = 30_000,
): Promise<void> {
  const logger = getLogger();
  try {
    await service.waitUntilContainerReady(containerName, timeoutMs);
    return;
  } catch (error) {
    const message = getErrorMessage(error);
    if (await hasContainerCrashed(service, containerName, message)) {
      logger.error(`Container crashed during startup: ${message}`);
      await dumpContainerLogs(service, containerName);
      throw new Error(
        `Container ${containerName} crashed during startup: ${message}`,
      );
    }
  }

  logger.error(`Container failed to become ready within ${timeoutMs}ms`);
  await dumpContainerLogs(service, containerName);
  throw new Error(
    `Container ${containerName} did not become ready within ${timeoutMs}ms`,
  );
}

// ---------------------------------------------------------------------------
// Idle detection
// ---------------------------------------------------------------------------

/**
 * Check if a container has no active exec sessions.
 *
 * Cleans stale session markers (dead PIDs) then checks if any remain.
 * Returns true if the container is idle (no active sessions).
 */
async function isContainerIdle(
  service: ContainerRuntime,
  containerName: string,
): Promise<boolean> {
  try {
    await service.execInContainer(containerName, buildSessionIdleCommand());
    return true; // Exit 0 -> idle
  } catch (error) {
    getLogger().debug(
      `Container ${chalk.cyan(containerName)} still has active sessions: ${getErrorMessage(error)}`,
    );
    return false; // Exit 1 -> sessions still active
  }
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

/**
 * Clean up stopped containers and pick an available container name.
 * Useful when creating containers outside the normal reuse flow.
 */
export async function pickFreshContainerName(
  service: ContainerRuntime,
  slug: string,
): Promise<string> {
  await removeStoppedContainers(service, slug);
  const running = await queryRunningContainers(service, slug);
  const takenNames = new Set(running.map((c) => c.name));
  return pickContainerName(slug, takenNames);
}

/**
 * Create a fresh ephemeral container (no hash, no reuse).
 *
 * Used when container reuse is disabled (`--no-container-reuse`).
 * The container is started detached with `--rm` so Docker removes it
 * automatically when the idle watcher stops it.
 */
export async function createFreshContainer(
  service: ContainerRuntime,
  slug: string,
  containerArgs: string[],
  imageName: string,
): Promise<string> {
  const logger = getLogger();
  // Clean up stopped containers to free names (fallback for pre---rm containers)
  await removeStoppedContainers(service, slug);

  const running = await queryRunningContainers(service, slug);
  const takenNames = new Set(running.map((c) => c.name));
  const containerName = pickContainerName(slug, takenNames);

  logger.debug(`Creating fresh container (no reuse): ${containerName}`);
  await service.createContainer({
    name: containerName,
    extraArgs: getCreateContainerExtraArgs(containerArgs, imageName),
    image: imageName,
  });
  return containerName;
}

/**
 * Find a running container with a matching hash, or create a new one.
 *
 * Behavior:
 * - Running + matching hash → reuse (docker exec)
 * - Running + different hash and active sessions → preserve
 * - Running + different hash and no active sessions → remove
 * - Stopped → remove (defensive cleanup)
 * - No match → create new detached container
 *
 * Race safety: wraps query+create in a delayed retry loop. If two concurrent
 * invocations both try to create, one wins and the other waits for the
 * winner's container to become visible before it re-queries.
 *
 * @param service - Container runtime service
 * @param slug - Project slug
 * @param hash - Expected container hash
 * @param containerArgs - Container creation body args (from buildContainerArgs)
 * @param imageName - Image used when a new container is required
 * @returns Container name and whether it was newly created
 */
export async function findOrCreateContainer(
  service: ContainerRuntime,
  slug: string,
  hash: string,
  containerArgs: string[],
  imageName: string,
): Promise<FindOrCreateContainerResult> {
  const logger = getLogger();
  const clock = getClock();
  const retryDeadline = clock.now() + NAME_CONFLICT_RETRY_TIMEOUT_MS;
  let conflictAttempt = 0;

  while (true) {
    // 1. Clean up stopped containers for this project
    await removeStoppedContainers(service, slug);

    // 2. Query running containers and find one with matching hash
    const running = await removeIdleObsoleteContainers(
      service,
      await queryRunningContainers(service, slug),
      hash,
    );

    const matching = running.find((container) => container.hash === hash);
    if (matching) {
      logger.debug(
        `Reusing existing container: ${matching.name} (hash=${hash})`,
      );
      return { containerName: matching.name, created: false };
    }

    // 3. No matching container - create a new one
    const takenNames = new Set(running.map((c) => c.name));
    const containerName = pickContainerName(slug, takenNames);

    logger.debug(`Creating new container: ${containerName} (hash=${hash})`);

    try {
      await service.createContainer({
        name: containerName,
        labels: { [SANDBOX_HASH_LABEL]: hash },
        extraArgs: getCreateContainerExtraArgs(containerArgs, imageName),
        image: imageName,
      });
      return { containerName, created: true };
    } catch (err) {
      if (!isNameConflict(err)) {
        throw err;
      }
      if (clock.now() >= retryDeadline) {
        throw new Error(
          `Failed to find or create container within ${NAME_CONFLICT_RETRY_TIMEOUT_MS}ms`,
        );
      }
      conflictAttempt++;
      logger.debug(
        `Name conflict for ${containerName}, waiting for the concurrent container (attempt ${conflictAttempt})...`,
      );
      await clock.sleep(NAME_CONFLICT_RETRY_DELAY_MS);
    }
  }
}

/**
 * Check if a docker error indicates a container name conflict.
 */
function isNameConflict(err: unknown): boolean {
  const msg = getErrorMessage(err);
  return msg.includes("is already in use") || msg.includes("name is taken");
}
