import {
  isNetworkPortSelection,
  type NetworkPortSelection,
} from "#modules/configuration/index.js";
import { deduplicateAllowedNetworks } from "../allowed-network-formatting.js";
import type { NetworkPolicy } from "../network-policy.js";

export type NetworkBootstrapRequest = NetworkPolicy;

function invalidRequest(detail: string): never {
  throw new Error(`Invalid network bootstrap request: ${detail}`);
}

export function parseNetworkBootstrapRequest(
  serialized: string | undefined,
): NetworkBootstrapRequest {
  if (!serialized) invalidRequest("SANDBOX_FIREWALL is missing");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    invalidRequest("expected valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidRequest("expected an object");
  }
  const candidate = value as Record<string, unknown>;
  for (const key of ["enabled", "fullNetwork", "noProxy"] as const) {
    if (typeof candidate[key] !== "boolean") {
      invalidRequest(`${key} must be a boolean`);
    }
  }
  if (!Array.isArray(candidate.allowNetwork)) {
    invalidRequest("allowNetwork must be an array");
  }
  const allowNetwork = candidate.allowNetwork.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      invalidRequest(`allowNetwork[${index}] must be an object`);
    }
    const network = entry as Record<string, unknown>;
    if (typeof network.host !== "string" || network.host.trim() === "") {
      invalidRequest(`allowNetwork[${index}].host must be a non-empty string`);
    }
    if (typeof network.wildcard !== "boolean") {
      invalidRequest(`allowNetwork[${index}].wildcard must be a boolean`);
    }
    const ports = network.ports;
    if (!isNetworkPortSelection(ports)) {
      invalidRequest(
        `allowNetwork[${index}].ports must be '*' or contain integer ports from 1 to 65535`,
      );
    }
    const validatedPorts: NetworkPortSelection = ports;
    return {
      host: network.host,
      wildcard: network.wildcard,
      ports: validatedPorts,
    };
  });

  return {
    enabled: candidate.enabled as boolean,
    fullNetwork: candidate.fullNetwork as boolean,
    noProxy: candidate.noProxy as boolean,
    allowNetwork: deduplicateAllowedNetworks(allowNetwork),
  };
}
