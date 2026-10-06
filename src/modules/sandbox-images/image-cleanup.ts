import chalk from "chalk";
import type { SandboxImageBuilder } from "#platform/container-runtime/index.js";
import { getLogger } from "#platform/logging/index.js";
import { readState, writeState } from "#platform/state/index.js";

export const SANDBOX_MANAGED_IMAGE_LABEL = "sandbox.managed";

interface RemovalStats {
  readonly removed: number;
  readonly freedSpace: string;
}

interface SandboxImageCleanupServices {
  readonly imageBuilder: SandboxImageBuilder;
  readonly imageOwnershipKey: string;
}

export async function removeUnusedManagedImages(
  services: SandboxImageCleanupServices,
): Promise<RemovalStats> {
  const logger = getLogger();
  const prefix = `${services.imageOwnershipKey}:`;
  const state = readState();
  const sandboxImages = state.sandboxImages ?? {};
  const candidates = [
    ...new Set(
      Object.entries(sandboxImages)
        .filter(([key]) => key.startsWith(prefix))
        .flatMap(([, image]) => [image.digest, ...(image.ownedDigests ?? [])]),
    ),
  ];
  logger.debug(`Found ${candidates.length} managed image cleanup candidates`);
  const result = await services.imageBuilder.removeUnused({
    candidates,
    managedLabel: { key: SANDBOX_MANAGED_IMAGE_LABEL, value: "true" },
  });
  for (const image of result.removed) {
    logger.debug(`Removed unused managed image ${chalk.cyan(image.digest)}`);
  }
  for (const image of result.skipped) {
    logger.debug(`Kept image ${chalk.cyan(image.digest)}: ${image.reason}`);
  }
  if (result.removed.length > 0) {
    const removed = new Set(result.removed.map((image) => image.digest));
    writeState({
      sandboxImages: Object.fromEntries(
        Object.entries(sandboxImages).flatMap(([key, image]) => {
          if (!key.startsWith(prefix)) return [[key, image]];
          if (removed.has(image.digest)) return [];
          const retainedOwnedDigests = (image.ownedDigests ?? []).filter(
            (digest) => !removed.has(digest),
          );
          const updatedImage =
            retainedOwnedDigests.length > 0
              ? { ...image, ownedDigests: retainedOwnedDigests }
              : {
                  reference: image.reference,
                  digest: image.digest,
                  ...(image.labels ? { labels: image.labels } : {}),
                };
          return [[key, updatedImage]];
        }),
      ),
    });
  }
  return {
    removed: result.removed.length,
    freedSpace: formatImageSize(result.estimatedReclaimedBytes),
  };
}

/** @testonly */
export function formatImageSize(bytes: number): string {
  if (bytes === 0) return "0B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1000 && unitIndex < units.length - 1) {
    size /= 1000;
    unitIndex++;
  }

  const formatted =
    size >= 10 ? size.toFixed(1) : size.toFixed(2).replace(/\.?0+$/, "");

  return `${formatted}${units[unitIndex]}`;
}
