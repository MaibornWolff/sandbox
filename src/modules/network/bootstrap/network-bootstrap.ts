import { createContainerNetworkSystem } from "#platform/container-system/index.js";
import type { NetworkBootstrapRequest } from "./bootstrap-request-parsing.js";
import { renderDnsmasqConfig } from "./dnsmasq-config-rendering.js";
import { buildFirewallPlan, buildIpv6FirewallPlan } from "./firewall-plan.js";
import type { GuestHostMapping } from "./guest-host-mappings.js";
import { renderSquidConfig } from "./squid-config-rendering.js";

/** @lintignore Public semantic network lifecycle. */
export interface ContainerNetworkLifecycle {
  readonly failure: Promise<Error>;
}

const noNetworkFailure = new Promise<Error>(() => undefined);

export async function startContainerNetwork(
  request: NetworkBootstrapRequest,
  options: {
    readonly signal?: AbortSignal;
    readonly hostMappings: readonly GuestHostMapping[];
    readonly hostAccessName: string;
  },
): Promise<ContainerNetworkLifecycle> {
  const network = createContainerNetworkSystem({
    ...(options.signal ? { signal: options.signal } : {}),
  });
  await network.applyHostMappings(options.hostMappings);
  if (!request.enabled) return { failure: noNetworkFailure };
  await network.applyFirewall(buildFirewallPlan(request));
  const upstreamDns = request.noProxy
    ? undefined
    : await network.discoverUpstreamDns();
  await network.applyIpv6Firewall(buildIpv6FirewallPlan(request, upstreamDns));
  if (!request.noProxy && upstreamDns) {
    await network.startDnsmasq({
      config: renderDnsmasqConfig(
        request,
        upstreamDns,
        options.hostMappings,
        options.hostAccessName,
      ),
    });
    await network.startSquid(renderSquidConfig(request));
  }
  await network.startNetworkTrace();
  return { failure: network.failure };
}
