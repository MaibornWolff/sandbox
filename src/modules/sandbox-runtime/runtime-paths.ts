import path from "node:path";
import { getHostEnvironment } from "#platform/environment/index.js";

const RUNTIME_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*-[a-f0-9]{64}$/;

export function getRuntimeId(version: string, contentHash: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    throw new Error(`Invalid Sandbox runtime version: ${version}`);
  }
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new Error(`Invalid Sandbox runtime content hash: ${contentHash}`);
  }
  return `${version}-${contentHash}`;
}

export function isRuntimeId(value: string): boolean {
  return RUNTIME_ID_PATTERN.test(value);
}

export function getContainerRuntimeDirectory(): string {
  return "/opt/sandbox-cli";
}

export function getRuntimeCacheRoot(): string {
  return path.join(
    getHostEnvironment().dataHomeDirectory,
    "sandbox",
    "runtime",
  );
}

export function getRuntimeCleanupTimestampPath(): string {
  return path.join(getRuntimeCacheRoot(), ".last-cleanup");
}

export function getRuntimeLeaseRoot(runtimeId: string): string {
  return path.join(getRuntimeCacheRoot(), ".leases", runtimeId);
}

export function getRuntimeCleanupLockPath(runtimeId: string): string {
  return path.join(getRuntimeCacheRoot(), ".cleanup-locks", runtimeId);
}
