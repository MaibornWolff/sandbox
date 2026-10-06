import type { SandboxRuntime } from "#platform/container-runtime/index.js";

const SANDBOX_PROJECT_LABEL = "sandbox.project";

export interface NetworkContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
}

interface FindNetworkContainersOptions {
  readonly status?: "all" | "running" | "exited";
  readonly projectSlug?: string;
}

export async function findNetworkContainers(
  service: SandboxRuntime,
  options: FindNetworkContainersOptions = {},
): Promise<NetworkContainer[]> {
  const { status = "all", projectSlug } = options;
  const entries = await service.instances.list({
    all: status === "all",
    labels: {
      [SANDBOX_PROJECT_LABEL]: projectSlug ?? null,
    },
    ...(status === "all" ? {} : { states: [status] }),
  });
  return entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    image: entry.image.reference.replace(/^localhost\//u, ""),
  }));
}
