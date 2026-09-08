import type { AllowedNetwork, Config } from "#modules/configuration/index.js";
import { deduplicateAllowedNetworks } from "./allowed-network-formatting.js";

export interface NetworkPolicy {
  enabled: boolean;
  allowNetwork: AllowedNetwork[];
  fullNetwork: boolean;
  noProxy: boolean;
}

export function normalizeNetworkPolicy(config: Config): NetworkPolicy {
  return {
    enabled: true,
    allowNetwork: deduplicateAllowedNetworks(config.allowNetwork),
    fullNetwork: config.fullNetwork,
    noProxy: config.noProxy,
  };
}
