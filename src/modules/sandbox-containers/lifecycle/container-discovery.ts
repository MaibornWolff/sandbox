import type {
  SandboxInstanceOperations,
  SandboxInstanceSummary,
} from "#platform/container-runtime/index.js";
import { SANDBOX_HASH_LABEL } from "../container-hashing.js";
import {
  SANDBOX_PROJECT_DIR_LABEL,
  SANDBOX_PROJECT_LABEL,
} from "../container-labels.js";

export interface SandboxContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly projectSlug: string;
  /** `null` for containers from older CLIs without the folder label. */
  readonly projectDir: string | null;
  readonly hash: string | null;
  readonly startedAt: Date | null;
}

type ContainerStatus = "all" | "running" | "exited";

interface FindContainersOptions {
  readonly status?: ContainerStatus;
  readonly projectSlug?: string;
}

export async function findSandboxContainers(
  service: { readonly instances: Pick<SandboxInstanceOperations, "list"> },
  options: FindContainersOptions = {},
): Promise<SandboxContainer[]> {
  const { status = "all", projectSlug } = options;
  const entries = await service.instances.list({
    all: status === "all",
    labels: { [SANDBOX_PROJECT_LABEL]: projectSlug ?? null },
    ...(status === "all" ? {} : { states: [status] }),
  });
  return entries.map(toSandboxContainer);
}

export function toSandboxContainer(
  entry: SandboxInstanceSummary,
): SandboxContainer {
  return {
    id: entry.id,
    name: entry.name,
    image: entry.image.reference.replace(/^localhost\//u, ""),
    projectSlug: entry.labels[SANDBOX_PROJECT_LABEL] ?? "",
    projectDir: entry.labels[SANDBOX_PROJECT_DIR_LABEL] ?? null,
    hash: entry.labels[SANDBOX_HASH_LABEL] ?? null,
    startedAt: entry.startedAt,
  };
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
