import { getClock } from "#platform/clock/index.js";
import type {
  SandboxInstanceSpec,
  SandboxInstanceSummary,
  SandboxRuntime,
} from "#platform/container-runtime/index.js";
import { SandboxInstanceNameConflictError } from "#platform/container-runtime/index.js";
import { getLogger } from "#platform/logging/index.js";
import { SANDBOX_HASH_LABEL } from "../container-hashing.js";
import { SANDBOX_PROJECT_LABEL } from "../container-labels.js";
import { getContainerBaseName } from "../container-naming.js";
import { findAvailableName } from "./container-discovery.js";

interface FindOrCreateContainerResult {
  readonly containerName: string;
  readonly created: boolean;
}

const NAME_CONFLICT_RETRY_TIMEOUT_MS = 10_000;
const NAME_CONFLICT_RETRY_DELAY_MS = 250;

interface RunningContainer {
  readonly id: string;
  readonly name: string;
  readonly hash: string | null;
  readonly state: SandboxInstanceSummary["state"];
}

async function queryRetainedContainers(
  service: SandboxRuntime,
  projectSlug: string,
): Promise<RunningContainer[]> {
  const logger = getLogger();
  let entries: SandboxInstanceSummary[];
  try {
    entries = await service.instances.list({
      all: true,
      labels: { [SANDBOX_PROJECT_LABEL]: projectSlug },
    });
  } catch (error) {
    logger.warn(
      `Could not establish stopped-container cleanup safety: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
  const retained: RunningContainer[] = [];
  for (const entry of entries) {
    const container = {
      id: entry.id,
      name: entry.name,
      hash: entry.labels[SANDBOX_HASH_LABEL] ?? null,
      state: entry.state,
    };
    if (entry.state !== "exited" && entry.state !== "dead") {
      retained.push(container);
      continue;
    }
    try {
      await service.instances.remove(entry.id, { force: true });
      logger.debug(`Removed stopped container: ${entry.id}`);
    } catch (error) {
      logger.warn(
        `Could not remove stopped container ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      retained.push(container);
    }
  }
  return retained;
}

function pickContainerName(slug: string, takenNames: Set<string>): string {
  return findAvailableName(getContainerBaseName(slug), takenNames);
}

async function isContainerIdle(
  service: SandboxRuntime,
  containerName: string,
): Promise<boolean> {
  const result = await service.instances.exec(containerName, {
    command: [
      "sh",
      "-c",
      'for f in /tmp/sandbox-sessions/*; do [ -f "$f" ] || continue; kill -0 "$(basename "$f")" 2>/dev/null || rm -f "$f"; done; [ -z "$(ls /tmp/sandbox-sessions/ 2>/dev/null)" ]',
    ],
  });
  return result.exitCode === 0;
}

async function removeIdleObsoleteContainer(
  service: SandboxRuntime,
  container: RunningContainer,
  expectedHash: string,
): Promise<RunningContainer | null> {
  if (container.hash === expectedHash || container.state !== "running")
    return container;
  const logger = getLogger();
  if (!(await isContainerIdle(service, container.id))) {
    logger.debug(
      `Container ${container.name} has a different hash (${container.hash}) and active sessions, leaving it running`,
    );
    return container;
  }
  try {
    await service.instances.remove(container.id, { force: true });
    logger.debug(`Removed idle obsolete container: ${container.name}`);
    return null;
  } catch (error) {
    logger.warn(
      `Could not remove idle obsolete container ${container.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return container;
  }
}

async function removeIdleObsoleteContainers(
  service: SandboxRuntime,
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

export async function pickFreshContainerName(
  service: SandboxRuntime,
  slug: string,
): Promise<string> {
  const running = await queryRetainedContainers(service, slug);
  return pickContainerName(slug, new Set(running.map((entry) => entry.name)));
}

function withContainerIdentity(
  spec: SandboxInstanceSpec,
  name: string,
  labels: Readonly<Record<string, string>> = {},
): SandboxInstanceSpec {
  return {
    ...spec,
    name,
    labels: { ...spec.labels, ...labels },
  };
}

export async function createFreshContainer(
  service: SandboxRuntime,
  slug: string,
  spec: SandboxInstanceSpec,
): Promise<string> {
  const running = await queryRetainedContainers(service, slug);
  const containerName = pickContainerName(
    slug,
    new Set(running.map((entry) => entry.name)),
  );
  getLogger().debug(`Creating fresh container: ${containerName}`);
  await service.instances.startDetached(
    withContainerIdentity(spec, containerName),
  );
  return containerName;
}

export async function findOrCreateContainer(
  service: SandboxRuntime,
  slug: string,
  hash: string,
  spec: SandboxInstanceSpec,
): Promise<FindOrCreateContainerResult> {
  const logger = getLogger();
  const clock = getClock();
  const retryDeadline = clock.now() + NAME_CONFLICT_RETRY_TIMEOUT_MS;
  let conflictAttempt = 0;
  while (true) {
    const running = await removeIdleObsoleteContainers(
      service,
      await queryRetainedContainers(service, slug),
      hash,
    );
    const matching = running.find(
      (container) =>
        container.hash === hash &&
        (container.state === "running" || container.state === "created"),
    );
    if (matching) {
      logger.debug(
        `Reusing existing container: ${matching.name} (hash=${hash})`,
      );
      return {
        containerName: matching.name,
        created: matching.state === "created",
      };
    }
    const containerName = pickContainerName(
      slug,
      new Set(running.map((entry) => entry.name)),
    );
    try {
      await service.instances.startDetached(
        withContainerIdentity(spec, containerName, {
          [SANDBOX_HASH_LABEL]: hash,
        }),
      );
      return { containerName, created: true };
    } catch (error) {
      if (!(error instanceof SandboxInstanceNameConflictError)) throw error;
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
