import path from "node:path";
import chalk from "chalk";
import type { Mount } from "#modules/storage/index.js";
import {
  copyDirectory,
  createTemporaryDirectoryIn,
  ensureDirectory,
  getPathType,
  hashDirectoryContents,
  removePath,
  renamePath,
} from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import { acquireRuntimeCacheLease } from "./runtime-coordination.js";
import { type RuntimePackage, readRuntimePackage } from "./runtime-package.js";
import {
  getContainerRuntimeDirectory,
  getRuntimeCacheRoot,
  getRuntimeId,
} from "./runtime-paths.js";

export const SANDBOX_RUNTIME_LABEL = "sandbox.runtime";

export interface CachedSandboxPackage extends AsyncDisposable {
  readonly id: string;
  readonly mount: Mount;
}

function publishRuntimePackage(
  runtimePackage: RuntimePackage,
  destination: string,
  expectedHash: string,
): void {
  const cacheRoot = path.dirname(destination);
  ensureDirectory(cacheRoot);
  const temporaryDirectory = createTemporaryDirectoryIn(cacheRoot, ".runtime-");
  using _cleanup = {
    [Symbol.dispose]: () => removePath(temporaryDirectory),
  };
  copyDirectory(runtimePackage.directory, temporaryDirectory);

  const copiedHash = hashDirectoryContents(temporaryDirectory);
  if (copiedHash !== expectedHash) {
    throw new Error(
      "Sandbox runtime package changed while it was copied. Finish the build and retry.",
    );
  }

  try {
    renamePath(temporaryDirectory, destination);
  } catch (error) {
    if (getPathType(destination) !== "directory") throw error;
  }
}

/** @testonly */
export async function prepareSandboxRuntimeFromPackage(
  runtimePackage: RuntimePackage,
): Promise<CachedSandboxPackage> {
  const contentHash = hashDirectoryContents(runtimePackage.directory);
  const id = getRuntimeId(runtimePackage.version, contentHash);
  const lease = await acquireRuntimeCacheLease(id);
  let leaseTransferred = false;
  await using _releaseLeaseOnFailure = {
    async [Symbol.asyncDispose]() {
      if (!leaseTransferred) await lease[Symbol.asyncDispose]();
    },
  };
  const destination = path.join(getRuntimeCacheRoot(), id);
  if (getPathType(destination) !== "directory") {
    getLogger().debug(
      `Caching Sandbox runtime ${chalk.cyan(id)} in ${chalk.dim(destination)}`,
    );
    publishRuntimePackage(runtimePackage, destination, contentHash);
  }
  const result: CachedSandboxPackage = {
    id,
    mount: {
      hostPath: destination,
      containerPath: getContainerRuntimeDirectory(),
      mode: "ro",
    },
    [Symbol.asyncDispose]: () => lease[Symbol.asyncDispose](),
  };
  leaseTransferred = true;
  return result;
}

export function prepareSandboxRuntime(): Promise<CachedSandboxPackage> {
  return prepareSandboxRuntimeFromPackage(readRuntimePackage());
}

export function getCurrentSandboxRuntimeId(): string {
  const runtimePackage = readRuntimePackage();
  return getRuntimeId(runtimePackage.version, runtimePackage.contentHash);
}
