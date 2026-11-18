import chalk from "chalk";
import { getConfigurationService } from "#modules/configuration/index.js";
import { getClock } from "#platform/clock/index.js";
import type { SandboxRuntime } from "#platform/container-runtime/index.js";
import { getRuntimeProvider } from "#platform/container-runtime/index.js";
import {
  buildSessionStatusCommand,
  type ContainerSession,
  type ContainerSessionStatus,
  parseSessionStatus,
} from "#platform/container-system/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { getRepoRootPath } from "#platform/git/index.js";
import { getLogger } from "#platform/logging/index.js";
import { getErrorMessage } from "#shared/errors/index.js";
import { generateProjectSlug } from "#shared/text/index.js";
import { getContainerHash } from "../container-hashing.js";
import {
  findSandboxContainers,
  type SandboxContainer,
} from "./container-discovery.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContainerStatusInfo {
  name: string;
  image: string;
  uptime: string;
  hash: string | null;
  /** `null` if the status probe failed. */
  ready: boolean | null;
  /** Sorted by start time and PID. `null` if the status probe failed. */
  sessions: readonly ContainerSession[] | null;
}

export interface SandboxStatus {
  projectSlug: string;
  runtime: string;
  containers: ContainerStatusInfo[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get human-readable uptime for a container.
 * @testonly
 */
export async function getContainerUptime(
  service: SandboxRuntime,
  containerId: string,
): Promise<string> {
  const startedAt = (await service.instances.inspect(containerId))?.startedAt;
  if (!startedAt) return "unknown";
  const seconds = Math.max(
    0,
    Math.floor((getClock().now() - startedAt.getTime()) / 1_000),
  );
  if (seconds < 60) return `Up ${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Up ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Up ${hours} hours` : `Up ${Math.floor(hours / 24)} days`;
}

function compareSessions(
  left: ContainerSession,
  right: ContainerSession,
): number {
  return (
    left.startedAt.getTime() - right.startedAt.getTime() || left.pid - right.pid
  );
}

/**
 * Read the ready state and the live sessions of a container with one
 * read-only probe. Returns `null` and logs the reason if the probe fails.
 */
export async function readContainerSessionStatus(
  service: SandboxRuntime,
  container: Pick<SandboxContainer, "id" | "name">,
): Promise<ContainerSessionStatus | null> {
  try {
    const result = await service.instances.exec(container.id, {
      command: buildSessionStatusCommand(),
      user: "root",
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `The status probe exited with code ${result.exitCode}: ${result.stderr.trim()}`,
      );
    }
    const status = parseSessionStatus(result.stdout);
    return {
      ready: status.ready,
      sessions: [...status.sessions].sort(compareSessions),
    };
  } catch (error) {
    getLogger().debug(
      `Could not read the session status of ${chalk.cyan(container.name)}: ${getErrorMessage(error)}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

/**
 * Gather full status info for the current project's sandbox containers.
 */
export async function getSandboxStatus(): Promise<SandboxStatus> {
  const { runtime } = await getRuntimeProvider().resolve(
    getConfigurationService().loadUserRuntimeResolution(),
  );
  const projectSlug = generateProjectSlug(
    await getRepoRootPath(getHostEnvironment().currentWorkingDirectory),
  );

  // Find running containers for this project
  const containers = await findSandboxContainers(runtime, {
    status: "running",
    projectSlug,
  });

  // Gather details for each container in parallel
  const containerStatuses = await Promise.all(
    containers.map(async (container): Promise<ContainerStatusInfo> => {
      const [uptime, hash, sessionStatus] = await Promise.all([
        getContainerUptime(runtime, container.id),
        getContainerHash(runtime, container.id),
        readContainerSessionStatus(runtime, container),
      ]);

      return {
        name: container.name,
        image: container.image,
        uptime,
        hash,
        ready: sessionStatus?.ready ?? null,
        sessions: sessionStatus?.sessions ?? null,
      };
    }),
  );

  return {
    projectSlug,
    runtime: runtime.runtime,
    containers: containerStatuses,
  };
}
