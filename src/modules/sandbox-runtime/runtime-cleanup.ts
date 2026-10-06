import path from "node:path";
import chalk from "chalk";
import { getClock } from "#platform/clock/index.js";
import type { ContainerRuntime } from "#platform/container-runtime/index.js";
import {
  getPathModifiedTime,
  getPathType,
  listDirectory,
  pathExists,
  readTextFile,
  removeDirectory,
  writeTextFile,
} from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import {
  getCurrentSandboxRuntimeId,
  SANDBOX_RUNTIME_LABEL,
} from "./runtime-cache.js";
import {
  hasActiveRuntimeCacheLease,
  tryAcquireRuntimeCleanupLock,
} from "./runtime-coordination.js";
import {
  getRuntimeCacheRoot,
  getRuntimeCleanupTimestampPath,
  isRuntimeId,
} from "./runtime-paths.js";

const CLEANUP_INTERVAL_MILLISECONDS = 24 * 60 * 60 * 1_000;
const MINIMUM_CACHE_AGE_MILLISECONDS = 24 * 60 * 60 * 1_000;

export type RuntimeCleanupPolicy = "scheduled" | "immediate";

function scheduledCleanupIsDue(now: number): boolean {
  const timestampPath = getRuntimeCleanupTimestampPath();
  if (!pathExists(timestampPath)) return true;
  const previous = Number(readTextFile(timestampPath));
  const age = now - previous;
  return (
    !Number.isFinite(previous) ||
    age < 0 ||
    age >= CLEANUP_INTERVAL_MILLISECONDS
  );
}

function findCleanupCandidates(
  currentRuntimeId: string,
  now: number,
): string[] {
  const cacheRoot = getRuntimeCacheRoot();
  if (getPathType(cacheRoot) !== "directory") return [];
  return listDirectory(cacheRoot).filter((name) => {
    if (name === currentRuntimeId || !isRuntimeId(name)) return false;
    const candidate = path.join(cacheRoot, name);
    return (
      getPathType(candidate) === "directory" &&
      now - getPathModifiedTime(candidate) >= MINIMUM_CACHE_AGE_MILLISECONDS
    );
  });
}

async function findAssignedRuntimeIds(
  runtime: ContainerRuntime,
): Promise<Set<string>> {
  const containers = await runtime.listContainers({
    all: true,
    labelFilter: SANDBOX_RUNTIME_LABEL,
    labelKeys: [SANDBOX_RUNTIME_LABEL],
    throwOnError: true,
  });
  return new Set(
    containers
      .map((container) => container.labels?.[SANDBOX_RUNTIME_LABEL])
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
}

function recordCleanup(now: number): void {
  writeTextFile(getRuntimeCleanupTimestampPath(), String(now));
}

function removeUnassignedCandidates(
  candidates: readonly string[],
  assignedRuntimeIds: ReadonlySet<string>,
  now: number,
): void {
  const logger = getLogger();
  for (const id of candidates) {
    if (assignedRuntimeIds.has(id)) continue;
    const cleanupLock = tryAcquireRuntimeCleanupLock(id, now);
    if (!cleanupLock) continue;
    using _cleanupLock = cleanupLock;
    if (hasActiveRuntimeCacheLease(id, now)) continue;
    const directory = path.join(getRuntimeCacheRoot(), id);
    try {
      removeDirectory(directory);
      logger.debug(`Removed cached Sandbox runtime ${chalk.cyan(id)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Could not remove cached Sandbox runtime ${id}: ${message}`);
    }
  }
}

export async function cleanupSandboxRuntimeCache(
  runtime: ContainerRuntime,
  options: {
    readonly currentRuntimeId: string;
    readonly policy: RuntimeCleanupPolicy;
  },
): Promise<void> {
  const now = getClock().now();
  if (options.policy === "scheduled" && !scheduledCleanupIsDue(now)) return;

  const candidates = findCleanupCandidates(options.currentRuntimeId, now);
  if (candidates.length === 0) {
    if (getPathType(getRuntimeCacheRoot()) === "directory") recordCleanup(now);
    return;
  }

  const logger = getLogger();
  let assignedRuntimeIds: Set<string>;
  try {
    assignedRuntimeIds = await findAssignedRuntimeIds(runtime);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Could not inspect runtime cache assignments: ${message}`);
    return;
  }

  removeUnassignedCandidates(candidates, assignedRuntimeIds, now);
  recordCleanup(now);
}

export function cleanupCurrentSandboxRuntimeCache(
  runtime: ContainerRuntime,
): Promise<void> {
  return cleanupSandboxRuntimeCache(runtime, {
    currentRuntimeId: getCurrentSandboxRuntimeId(),
    policy: "immediate",
  });
}

export function cleanupSandboxRuntimeAfterSession(
  runtime: ContainerRuntime,
  currentRuntimeId: string,
): AsyncDisposable {
  return {
    async [Symbol.asyncDispose]() {
      try {
        await cleanupSandboxRuntimeCache(runtime, {
          currentRuntimeId,
          policy: "scheduled",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        getLogger().warn(
          `Could not clean the Sandbox runtime cache: ${message}`,
        );
      }
    },
  };
}
