import type { AllowedNetwork } from "#modules/configuration/index.js";
import {
  DEFAULT_NETWORK_PORTS,
  formatNetworkDomain,
  getUncoveredPorts,
  groupPortsByDomain,
} from "#modules/network/index.js";
import type { NetworkLogEntry } from "./network-diagnostics.js";

interface AllowDomainChoice {
  readonly name: string;
  readonly value: string;
  readonly checked: false;
  readonly disabled?: string;
}

const restartSandboxReason = "Configured. Restart sandbox.";

export function deriveAllowDomainChoices(
  entries: readonly NetworkLogEntry[],
  allowedNetworks: readonly AllowedNetwork[],
): AllowDomainChoice[] {
  const domainPorts = groupPortsByDomain(
    entries.filter((entry) => entry.status === "BLOCKED"),
  );
  const choices: AllowDomainChoice[] = [];

  for (const [domain, ports] of domainPorts) {
    const portsToCheck =
      ports.size === 0 ? new Set<number>(DEFAULT_NETWORK_PORTS) : ports;
    const uncoveredPorts = getUncoveredPorts(domain, portsToCheck, [
      ...allowedNetworks,
    ]);
    const coveredPorts = new Set(
      [...portsToCheck].filter((port) => !uncoveredPorts.has(port)),
    );
    if (coveredPorts.size > 0) {
      const value = formatNetworkDomain(domain, coveredPorts);
      choices.push({
        name: value,
        value,
        checked: false,
        disabled: restartSandboxReason,
      });
    }
    if (uncoveredPorts.size > 0) {
      const value = formatNetworkDomain(domain, uncoveredPorts);
      choices.push({ name: value, value, checked: false });
    }
  }

  return choices.sort((left, right) => left.value.localeCompare(right.value));
}
