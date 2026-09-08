import { getSandboxImageGlob } from "#modules/sandbox-resources/index.js";
import type { ContainerRuntime } from "#platform/container-runtime/index.js";
import { getLogger } from "#platform/logging/index.js";

/**
 * Represents a dangling Docker image
 */
interface DanglingImage {
  id: string;
  size: number;
  created: string;
}

/**
 * Statistics from image removal operation
 */
interface RemovalStats {
  removed: number;
  freedSpace: string;
}

/**
 * Query dangling images (untagged images from sandbox builds)
 * Uses --filter dangling=true to only find untagged images
 * Does NOT affect Docker build cache layers
 */
async function getDanglingImages(
  service: ContainerRuntime,
): Promise<DanglingImage[]> {
  try {
    const entries = await service.listDanglingImages(getSandboxImageGlob());
    return entries.map((e) => ({
      id: e.id,
      size: e.size,
      created: e.created,
    }));
  } catch (err) {
    getLogger().debug(`Failed to query dangling images: ${err}`);
    return [];
  }
}

/**
 * Check if any containers are using the specified image
 */
async function getContainersUsingImage(
  imageId: string,
  service: ContainerRuntime,
): Promise<string[]> {
  try {
    return await service.getContainersUsingImage(imageId);
  } catch (err) {
    getLogger().debug(
      `Failed to check containers for image ${imageId}: ${err}`,
    );
    return [];
  }
}

/**
 * Safely remove dangling images
 * Checks if images are in use before removal
 */
export async function removeDanglingImages(
  service: ContainerRuntime,
): Promise<RemovalStats> {
  const images = await getDanglingImages(service);

  if (images.length === 0) {
    return { removed: 0, freedSpace: "0B" };
  }

  let removed = 0;
  let totalFreed = 0;
  const logger = getLogger();

  for (const image of images) {
    // Safety check: ensure no containers are using this image
    const containers = await getContainersUsingImage(image.id, service);
    if (containers.length > 0) {
      logger.debug(
        `Skipping image ${image.id} - used by ${containers.length} container(s)`,
      );
      continue;
    }

    try {
      await service.removeImage(image.id);
      removed++;
      totalFreed += image.size;
      logger.debug(`Removed dangling image: ${image.id}`);
    } catch (err) {
      logger.debug(`Failed to remove image ${image.id}: ${err}`);
    }
  }

  return {
    removed,
    freedSpace: formatImageSize(totalFreed),
  };
}

/**
 * Format bytes to human-readable size
 * Returns formats like "1.2MB", "500KB", "2.5GB"
 * @testonly
 */
export function formatImageSize(bytes: number): string {
  if (bytes === 0) return "0B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1000 && unitIndex < units.length - 1) {
    size /= 1000;
    unitIndex++;
  }

  // Format to 1 decimal place for values >= 10, otherwise 2 decimal places
  const formatted =
    size >= 10 ? size.toFixed(1) : size.toFixed(2).replace(/\.?0+$/, "");

  return `${formatted}${units[unitIndex]}`;
}
