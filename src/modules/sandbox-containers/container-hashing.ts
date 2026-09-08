import * as crypto from "node:crypto";
import type { ContainerRuntime } from "#platform/container-runtime/index.js";

/**
 * Label key used to store the container hash for reuse detection
 */
export const SANDBOX_HASH_LABEL = "sandbox.hash";

/**
 * Compute a deterministic hash from sandbox version, image ID, and container creation args.
 *
 * The hash captures everything that defines the container's structural identity.
 * Container args should NOT include --name or --label sandbox.hash (those are derived from the hash).
 *
 * @param version - Sandbox CLI version
 * @param imageId - Docker image ID (from docker inspect)
 * @param containerArgs - Container creation args (mounts, env, ports, etc.)
 * @returns 12-character hex hash
 */
export function computeContainerHash(
  version: string,
  imageId: string,
  containerArgs: string[],
): string {
  const hash = crypto.createHash("sha256");
  hash.update(version);
  hash.update("\0");
  hash.update(imageId);
  for (const arg of containerArgs) {
    hash.update("\0");
    hash.update(arg);
  }
  return hash.digest("hex").substring(0, 12);
}

/**
 * Get the full image ID for a Docker image.
 *
 * @param service - Container runtime service
 * @param imageName - Image name (e.g., "sandbox-base:latest")
 * @returns Full image ID string (e.g., "sha256:abc123...")
 */
export async function getImageId(
  service: ContainerRuntime,
  imageName: string,
): Promise<string> {
  return service.getImageId(imageName);
}

/**
 * Read the sandbox.hash label from a running container.
 *
 * @param service - Container runtime service
 * @param containerId - Container ID or name
 * @returns Hash string, or null if label not found or container doesn't exist
 */
export async function getContainerHash(
  service: ContainerRuntime,
  containerId: string,
): Promise<string | null> {
  try {
    return await service.getContainerLabel(containerId, SANDBOX_HASH_LABEL);
  } catch {
    return null;
  }
}
