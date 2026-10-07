import { getConfigurationService } from "#modules/configuration/index.js";
import { getClock } from "#platform/clock/index.js";
import type { SandboxRuntime } from "#platform/container-runtime/index.js";
import { getRuntimeProvider } from "#platform/container-runtime/index.js";
import { buildSessionDetailsCommand } from "#platform/container-system/index.js";
import { getLogger } from "#platform/logging/index.js";
import { getErrorMessage } from "#shared/errors/index.js";
import { generateProjectSlug } from "#shared/text/index.js";
import { getContainerHash } from "../container-hashing.js";
import type { SandboxOptions } from "../sandbox-options.js";
import { findSandboxContainers } from "./container-discovery.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionInfo {
  pid: string;
  command: string;
}

export interface ContainerStatusInfo {
  name: string;
  image: string;
  uptime: string;
  hash: string | null;
  sessions: SessionInfo[];
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

/**
 * Get active session details from a container's `/tmp/sandbox-sessions/` directory.
 *
 * Cleans stale markers (dead PIDs) then reads `/proc/<PID>/cmdline` for each
 * remaining session. Returns an empty array if the exec fails entirely.
 */
/** @lintignore Pure owner-local parser. */
export function parseSessionDetails(output: string): SessionInfo[] {
  const lines = output.trim().split("\n").filter(Boolean);
  const sessions: SessionInfo[] = [];
  for (const line of lines) {
    const sepIndex = line.indexOf("|");
    if (sepIndex === -1) continue;
    const pid = line.substring(0, sepIndex).trim();
    const command = line.substring(sepIndex + 1).trim() || "unknown";
    if (pid) sessions.push({ pid, command });
  }
  return sessions;
}

export async function getSessionDetails(
  service: SandboxRuntime,
  containerName: string,
): Promise<SessionInfo[]> {
  try {
    const result = await service.instances.exec(containerName, {
      command: buildSessionDetailsCommand(),
    });

    return result.exitCode === 0 ? parseSessionDetails(result.stdout) : [];
  } catch (error) {
    getLogger().debug(
      `Could not read sessions of ${containerName}: ${getErrorMessage(error)}`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

/**
 * Gather full status info for the current project's sandbox containers.
 */
export async function getSandboxStatus(
  cliOptions: SandboxOptions,
): Promise<SandboxStatus> {
  const { projectRoot, runtimeResolution } =
    await getConfigurationService().load(cliOptions);
  const { runtime } = await getRuntimeProvider().resolve(runtimeResolution);
  const projectSlug = generateProjectSlug(projectRoot);

  // Find running containers for this project
  const containers = await findSandboxContainers(runtime, {
    status: "running",
    projectSlug,
  });

  // Gather details for each container in parallel
  const containerStatuses = await Promise.all(
    containers.map(async (container): Promise<ContainerStatusInfo> => {
      const [uptime, hash, sessions] = await Promise.all([
        getContainerUptime(runtime, container.id),
        getContainerHash(runtime, container.id),
        getSessionDetails(runtime, container.name),
      ]);

      return {
        name: container.name,
        image: container.image,
        uptime,
        hash,
        sessions,
      };
    }),
  );

  return {
    projectSlug,
    runtime: runtime.runtime,
    containers: containerStatuses,
  };
}
