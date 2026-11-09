import type { SandboxRuntime } from "#platform/container-runtime/index.js";
import {
  type ContainerLogBundle,
  parseContainerLogBundle,
} from "#platform/container-system/index.js";

const CONTAINER_TOOLS_PATH = "/usr/local/bin/sandbox-container-tools";

export function buildContainerDiagnosticBundleCommand(): string[] {
  return [CONTAINER_TOOLS_PATH, "network", "diagnostics"];
}

export function buildContainerNetworkStateCommand(): string[] {
  return [CONTAINER_TOOLS_PATH, "network", "state"];
}

export async function execContainerDiagnostic(
  service: SandboxRuntime,
  containerId: string,
  command: readonly string[],
): Promise<string> {
  const result = await service.instances.exec(containerId, {
    command,
    user: "root",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Container diagnostic failed with exit code ${result.exitCode}: ${result.stderr}`,
    );
  }
  return result.stdout;
}

/** Read every network log of a container with one container command. */
export async function fetchContainerLogBundle(
  service: SandboxRuntime,
  containerId: string,
): Promise<ContainerLogBundle> {
  return parseContainerLogBundle(
    await execContainerDiagnostic(
      service,
      containerId,
      buildContainerDiagnosticBundleCommand(),
    ),
  );
}
