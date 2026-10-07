import type { SandboxRuntime } from "#platform/container-runtime/index.js";
import { SANDBOX_PROJECT_LABEL } from "../container-labels.js";

export interface SandboxContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
}

type ContainerStatus = "all" | "running" | "exited";

interface FindContainersOptions {
  readonly status?: ContainerStatus;
  readonly projectSlug?: string;
}

export async function findSandboxContainers(
  service: SandboxRuntime,
  options: FindContainersOptions = {},
): Promise<SandboxContainer[]> {
  const { status = "all", projectSlug } = options;
  const entries = await service.instances.list({
    all: status === "all",
    labels: { [SANDBOX_PROJECT_LABEL]: projectSlug ?? null },
    ...(status === "all" ? {} : { states: [status] }),
  });
  return entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    image: entry.image.reference.replace(/^localhost\//u, ""),
  }));
}

export function findAvailableName(
  baseName: string,
  takenNames: Set<string>,
): string {
  if (!takenNames.has(baseName)) return baseName;
  let suffix = 2;
  while (takenNames.has(`${baseName}-${suffix}`)) suffix++;
  return `${baseName}-${suffix}`;
}
