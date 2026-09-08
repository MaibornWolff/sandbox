import { getConfigurationService } from "#modules/configuration/index.js";
import type { ContainerRuntime } from "#platform/container-runtime/index.js";
import { getRuntimeProvider } from "#platform/container-runtime/index.js";
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
  service: ContainerRuntime,
  containerId: string,
): Promise<string> {
  return service.getContainerUptime(containerId);
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
  service: ContainerRuntime,
  containerName: string,
): Promise<SessionInfo[]> {
  try {
    const output = await service.execInContainer(containerName, [
      "sh",
      "-c",
      [
        "for f in /tmp/sandbox-sessions/*; do",
        '  [ -f "$f" ] || continue;',
        '  pid=$(basename "$f");',
        '  kill -0 "$pid" 2>/dev/null || { rm -f "$f"; continue; };',
        '  cmd=$(tr "\\0" " " < /proc/$pid/cmdline 2>/dev/null | head -c 200);',
        '  echo "$pid|$cmd";',
        "done",
      ].join(" "),
    ]);

    return parseSessionDetails(output);
  } catch {
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
  const { projectRoot, configuredRuntime } =
    await getConfigurationService().load(cliOptions);
  const runtimeService = await getRuntimeProvider().resolve(configuredRuntime);
  const projectSlug = generateProjectSlug(projectRoot);

  // Find running containers for this project
  const containers = await findSandboxContainers(runtimeService, {
    status: "running",
    projectSlug,
  });

  // Gather details for each container in parallel
  const containerStatuses = await Promise.all(
    containers.map(async (container): Promise<ContainerStatusInfo> => {
      const [uptime, hash, sessions] = await Promise.all([
        getContainerUptime(runtimeService, container.id),
        getContainerHash(runtimeService, container.id),
        getSessionDetails(runtimeService, container.name),
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
    runtime: runtimeService.runtime,
    containers: containerStatuses,
  };
}
