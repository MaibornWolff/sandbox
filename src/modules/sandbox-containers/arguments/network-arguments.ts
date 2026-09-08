import type { Config } from "#modules/configuration/index.js";
import {
  type NetworkPolicy,
  normalizeNetworkPolicy,
} from "#modules/network/index.js";
import { getLogger } from "#platform/logging/index.js";

export function addNetworkArguments(args: string[], config: Config): void {
  const logger = getLogger();
  const networkPolicy: NetworkPolicy = normalizeNetworkPolicy(config);
  args.push("-e", `SANDBOX_FIREWALL=${JSON.stringify(networkPolicy)}`);
  if (config.noProxy) args.push("-e", "SANDBOX_NO_PROXY=1");

  if (config.fullNetwork) {
    logger.debug(
      config.noProxy
        ? "Network firewall: unrestricted (full network, proxy disabled)"
        : "Network firewall: unrestricted (full network, proxy in allow-all mode)",
    );
  } else {
    logger.debug("Network firewall: restricted (proxy filtering enabled)");
  }
}

export function addPortArguments(args: string[], ports: string[]): void {
  const logger = getLogger();
  if (ports.length > 0) {
    logger.debug(`Port mappings (${ports.length}):`);
    for (const port of ports) logger.debug(`  ${port}`);
  }
  for (const port of ports) args.push("-p", port);
}
