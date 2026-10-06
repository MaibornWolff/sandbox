import * as crypto from "node:crypto";
import type {
  SandboxInstanceSpec,
  SandboxRuntime,
} from "#platform/container-runtime/index.js";

export const SANDBOX_HASH_LABEL = "sandbox.hash";

function sortedRecord(
  value: Readonly<Record<string, string>>,
  excludedKeys: ReadonlySet<string> = new Set(),
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !excludedKeys.has(key))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function computeContainerHash(options: {
  readonly version: string;
  readonly runtime: SandboxRuntime["runtime"];
  readonly runtimeCompatibilityIdentity: string;
  readonly imageIdentity: string;
  readonly spec: SandboxInstanceSpec;
}): string {
  const structuralIdentity = {
    contract: 1,
    version: options.version,
    runtime: options.runtime,
    runtimeCompatibilityIdentity: options.runtimeCompatibilityIdentity,
    imageIdentity: options.imageIdentity,
    labels: sortedRecord(options.spec.labels, new Set([SANDBOX_HASH_LABEL])),
    environment: sortedRecord(options.spec.environment),
    mounts: options.spec.mounts,
    ports: options.spec.ports,
    init: options.spec.init,
    removeOnExit: options.spec.removeOnExit,
    resources: options.spec.resources,
    security: options.spec.security,
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(structuralIdentity))
    .digest("hex")
    .substring(0, 12);
}

export async function computeRuntimeContainerHash(options: {
  readonly version: string;
  readonly service: Pick<
    SandboxRuntime,
    "runtime" | "getCompatibilityIdentity"
  >;
  readonly imageIdentity: string;
  readonly spec: SandboxInstanceSpec;
}): Promise<string> {
  const runtimeCompatibilityIdentity =
    await options.service.getCompatibilityIdentity();
  return computeContainerHash({
    version: options.version,
    runtime: options.service.runtime,
    runtimeCompatibilityIdentity,
    imageIdentity: options.imageIdentity,
    spec: options.spec,
  });
}

export async function getContainerHash(
  service: SandboxRuntime,
  containerId: string,
): Promise<string | null> {
  return (
    (await service.instances.inspect(containerId))?.labels[
      SANDBOX_HASH_LABEL
    ] ?? null
  );
}
