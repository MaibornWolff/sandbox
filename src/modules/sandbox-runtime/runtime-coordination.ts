import path from "node:path";
import { getClock } from "#platform/clock/index.js";
import {
  createTemporaryDirectoryIn,
  ensureDirectory,
  getPathModifiedTime,
  getPathType,
  listDirectory,
  removePath,
  setPathModifiedTime,
  tryCreateDirectory,
} from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import {
  getRuntimeCleanupLockPath,
  getRuntimeLeaseRoot,
} from "./runtime-paths.js";

const STALE_COORDINATION_MILLISECONDS = 24 * 60 * 60 * 1_000;
const LEASE_REFRESH_MILLISECONDS = 60 * 60 * 1_000;
const COORDINATION_RETRY_MILLISECONDS = 10;

function removeStalePath(candidate: string, now: number): boolean {
  if (getPathType(candidate) !== "directory") return false;
  if (now - getPathModifiedTime(candidate) < STALE_COORDINATION_MILLISECONDS) {
    return false;
  }
  removePath(candidate);
  return true;
}

function cleanupLockIsActive(runtimeId: string, now: number): boolean {
  const lockPath = getRuntimeCleanupLockPath(runtimeId);
  if (getPathType(lockPath) !== "directory") return false;
  return !removeStalePath(lockPath, now);
}

function warnAboutLeaseFailure(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  getLogger().warn(
    `Could not ${action} Sandbox runtime cache lease: ${message}`,
  );
}

function releaseLease(leasePath: string): void {
  try {
    removePath(leasePath);
  } catch (error) {
    warnAboutLeaseFailure("release", error);
  }
}

async function refreshLeaseUntilDisposed(
  leasePath: string,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await getClock().sleep(LEASE_REFRESH_MILLISECONDS, { signal });
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    try {
      setPathModifiedTime(leasePath, getClock().now());
    } catch (error) {
      warnAboutLeaseFailure("refresh", error);
      return;
    }
  }
}

export async function acquireRuntimeCacheLease(
  runtimeId: string,
): Promise<AsyncDisposable> {
  const leaseRoot = getRuntimeLeaseRoot(runtimeId);
  ensureDirectory(leaseRoot);
  while (true) {
    const now = getClock().now();
    if (cleanupLockIsActive(runtimeId, now)) {
      await getClock().sleep(COORDINATION_RETRY_MILLISECONDS);
      continue;
    }

    const leasePath = createTemporaryDirectoryIn(leaseRoot, "lease-");
    if (!cleanupLockIsActive(runtimeId, getClock().now())) {
      const abortHeartbeat = new AbortController();
      const heartbeat = refreshLeaseUntilDisposed(
        leasePath,
        abortHeartbeat.signal,
      );
      return {
        async [Symbol.asyncDispose]() {
          abortHeartbeat.abort();
          await heartbeat;
          releaseLease(leasePath);
        },
      };
    }
    releaseLease(leasePath);
    await getClock().sleep(COORDINATION_RETRY_MILLISECONDS);
  }
}

export function tryAcquireRuntimeCleanupLock(
  runtimeId: string,
  now: number,
): Disposable | null {
  const lockPath = getRuntimeCleanupLockPath(runtimeId);
  ensureDirectory(path.dirname(lockPath));
  if (!tryCreateDirectory(lockPath)) {
    if (!removeStalePath(lockPath, now) || !tryCreateDirectory(lockPath)) {
      return null;
    }
  }
  return {
    [Symbol.dispose]: () => removePath(lockPath),
  };
}

export function hasActiveRuntimeCacheLease(
  runtimeId: string,
  now: number,
): boolean {
  const leaseRoot = getRuntimeLeaseRoot(runtimeId);
  if (getPathType(leaseRoot) !== "directory") return false;
  for (const name of listDirectory(leaseRoot)) {
    const leasePath = path.join(leaseRoot, name);
    if (!removeStalePath(leasePath, now)) return true;
  }
  return false;
}
