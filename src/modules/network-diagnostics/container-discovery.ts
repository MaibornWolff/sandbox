import type {
  ContainerRuntime,
  ListContainersOptions,
} from "#platform/container-runtime/index.js";

const SANDBOX_PROJECT_LABEL = "sandbox.project";

export interface NetworkContainer {
  id: string;
  name: string;
  image: string;
}

interface FindNetworkContainersOptions {
  status?: "all" | "running" | "exited";
  projectSlug?: string;
}

export async function findNetworkContainers(
  service: ContainerRuntime,
  options: FindNetworkContainersOptions = {},
): Promise<NetworkContainer[]> {
  const { status = "all", projectSlug } = options;
  const listOptions: ListContainersOptions = {
    labelFilter: projectSlug
      ? `${SANDBOX_PROJECT_LABEL}=${projectSlug}`
      : SANDBOX_PROJECT_LABEL,
  };

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
  } catch {
    return [];
  }
}
