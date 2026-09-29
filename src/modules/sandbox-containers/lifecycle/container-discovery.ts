import type {
  ContainerRuntime,
  ListContainersOptions,
} from "#platform/container-runtime/index.js";
import { getLogger } from "#platform/logging/index.js";
import { getErrorMessage } from "#shared/errors/index.js";
import { SANDBOX_PROJECT_LABEL } from "../container-labels.js";

/**
 * Represents a sandbox container
 */
export interface SandboxContainer {
  id: string;
  name: string;
  image: string;
}

/**
 * Container status filter
 */
type ContainerStatus = "all" | "running" | "exited";

/**
 * Options for finding sandbox containers
 */
interface FindContainersOptions {
  /** Filter by container status (default: "all") */
  status?: ContainerStatus;
  /** Filter by project slug (only show containers whose image contains this slug) */
  projectSlug?: string;
}

/**
 * Find all sandbox containers
 *
 * @param service - The container runtime service
 * @param options - Options for filtering containers
 * @returns Array of sandbox containers, or empty array on error
 */
export async function findSandboxContainers(
  service: ContainerRuntime,
  options: FindContainersOptions = {},
): Promise<SandboxContainer[]> {
  const { status = "all", projectSlug } = options;

  const labelFilter = projectSlug
    ? `${SANDBOX_PROJECT_LABEL}=${projectSlug}`
    : SANDBOX_PROJECT_LABEL;

  const listOptions: ListContainersOptions = { labelFilter };

  if (status === "running") {
    listOptions.statusFilter = ["running"];
  } else if (status === "exited") {
    listOptions.statusFilter = ["exited"];
  } else {
    listOptions.all = true;
  }

  try {
    const entries = await service.listContainers(listOptions);
    return entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      image: entry.image.replace(/^localhost\//, ""),
    }));
  } catch (error) {
    getLogger().warn(
      `Could not list sandbox containers: ${getErrorMessage(error)}`,
    );
    return [];
  }
}

/**
 * Find the lowest available name: base name first, then base-2, base-3, etc.
 */
export function findAvailableName(
  baseName: string,
  takenNames: Set<string>,
): string {
  if (!takenNames.has(baseName)) return baseName;

  let suffix = 2;
  while (takenNames.has(`${baseName}-${suffix}`)) {
    suffix++;
  }
  return `${baseName}-${suffix}`;
}
