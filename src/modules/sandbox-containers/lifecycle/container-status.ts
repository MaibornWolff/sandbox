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
import type { StatusOptions } from "../sandbox-options.js";
import {
  findSandboxContainers,
  type SandboxContainer,
} from "./container-discovery.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContainerStatusInfo {
  id: string;
  name: string;
  projectSlug: string;
  /** `null` for containers from older CLIs without the folder label. */
  projectDir: string | null;
  image: string;
  startedAt: Date | null;
  hash: string | null;
  /** `null` if the status probe failed. */
  ready: boolean | null;
  /** Sorted by start time and PID. `null` if the status probe failed. */
  sessions: readonly ContainerSession[] | null;
}

export interface SandboxStatus {
  /**
   * `null` with `--all` and `--session`, because the containers can belong to
   * many projects.
   */
  projectSlug: string | null;
  /** Full ID of the looked-up session, or `null` without `--session`. */
  sessionId: string | null;
  runtime: "apple-container" | "docker" | "podman";
  containers: ContainerStatusInfo[];
}

/** A `--session` value that does not select exactly one session. */
export class SessionLookupError extends Error {}

const MIN_SESSION_ID_QUERY_LENGTH = 6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format the uptime of a container from its start time. */
export function getContainerUptime(startedAt: Date | null): string {
  if (!startedAt) return "unknown";
  const seconds = Math.max(
    0,
    Math.floor((getClock().now() - startedAt.getTime()) / 1_000),
  );
  if (seconds < 60) return `Up ${formatUnit(seconds, "second")}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Up ${formatUnit(minutes, "minute")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Up ${formatUnit(hours, "hour")}`;
  return `Up ${formatUnit(Math.floor(hours / 24), "day")}`;
}

function formatUnit(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
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

function compareContainers(
  left: SandboxContainer,
  right: SandboxContainer,
): number {
  return (
    left.projectSlug.localeCompare(right.projectSlug) ||
    // Containers without the folder label come first in their slug.
    (left.projectDir ?? "").localeCompare(right.projectDir ?? "") ||
    left.name.localeCompare(right.name)
  );
}

async function readContainerStatuses(
  runtime: SandboxRuntime,
  projectSlug: string | null,
): Promise<ContainerStatusInfo[]> {
  const containers = (
    await findSandboxContainers(runtime, {
      status: "running",
      ...(projectSlug === null ? {} : { projectSlug }),
    })
  ).sort(compareContainers);

  // Probe each container in parallel
  return Promise.all(
    containers.map(async (container): Promise<ContainerStatusInfo> => {
      const sessionStatus = await readContainerSessionStatus(
        runtime,
        container,
      );

      return {
        id: container.id,
        name: container.name,
        projectSlug: container.projectSlug,
        projectDir: container.projectDir,
        image: container.image,
        startedAt: container.startedAt,
        hash: container.hash,
        ready: sessionStatus?.ready ?? null,
        sessions: sessionStatus?.sessions ?? null,
      };
    }),
  );
}

/**
 * Find the one session whose ID starts with `query`. Returns its container
 * with only this session. Throws `SessionLookupError` for no match or for more
 * than one match.
 */
function selectSession(
  containers: readonly ContainerStatusInfo[],
  query: string,
): { container: ContainerStatusInfo; sessionId: string } {
  const matches = containers.flatMap((container) =>
    (container.sessions ?? []).flatMap((session) =>
      session.id?.startsWith(query)
        ? [{ container, session, id: session.id }]
        : [],
    ),
  );
  const [match, ...others] = matches;
  if (!match) {
    const unreadable = containers
      .filter((container) => container.sessions === null)
      .map((container) => container.name);
    throw new SessionLookupError(
      `No running session with ID ${query}.${
        unreadable.length > 0
          ? ` Could not read the sessions of ${unreadable.join(", ")}.`
          : ""
      }`,
    );
  }
  if (others.length > 0) {
    const ids = matches.map(({ id }) => id).sort();
    throw new SessionLookupError(
      `More than one session ID starts with ${query}: ${ids.join(", ")}. Use more characters.`,
    );
  }
  return {
    container: { ...match.container, sessions: [match.session] },
    sessionId: match.id,
  };
}

/**
 * Gather full status info for the running sandbox containers of the current
 * project, of all projects with `all`, or for the one session that `session`
 * selects in all projects.
 */
export async function getSandboxStatus(
  options: StatusOptions,
): Promise<SandboxStatus> {
  const { session } = options;
  if (session !== undefined && session.length < MIN_SESSION_ID_QUERY_LENGTH) {
    throw new SessionLookupError(
      `Use at least ${MIN_SESSION_ID_QUERY_LENGTH} characters of the session ID.`,
    );
  }

  const { runtime } = await getRuntimeProvider().resolve(
    getConfigurationService().loadUserRuntimeResolution(),
  );
  const projectSlug =
    options.all || session !== undefined
      ? null
      : generateProjectSlug(
          await getRepoRootPath(getHostEnvironment().currentWorkingDirectory),
        );

  const containers = await readContainerStatuses(runtime, projectSlug);
  if (session === undefined) {
    return {
      projectSlug,
      sessionId: null,
      runtime: runtime.runtime,
      containers,
    };
  }

  getLogger().debug(
    `Looking for session ${chalk.cyan(session)} in ${containers.length} running containers`,
  );
  const match = selectSession(containers, session);
  return {
    projectSlug,
    sessionId: match.sessionId,
    runtime: runtime.runtime,
    containers: [match.container],
  };
}
