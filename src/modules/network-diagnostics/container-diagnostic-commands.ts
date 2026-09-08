import type { ContainerLogSource } from "#platform/container-system/index.js";

export type NetworkDiagnosticSource = ContainerLogSource;

const CONTAINER_TOOLS_PATH = "/usr/local/bin/sandbox-container-tools";

export function buildContainerDiagnosticCommand(
  source: NetworkDiagnosticSource,
): string[] {
  return [CONTAINER_TOOLS_PATH, "network", "diagnostic", source];
}

export function buildContainerNetworkStateCommand(): string[] {
  return [CONTAINER_TOOLS_PATH, "network", "state"];
}
