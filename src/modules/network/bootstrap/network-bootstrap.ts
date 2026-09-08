import { createContainerNetworkSystem } from "#platform/container-system/index.js";
import type { NetworkBootstrapRequest } from "./bootstrap-request-parsing.js";
import { renderDnsmasqConfig } from "./dnsmasq-config-rendering.js";
import { buildFirewallPlan } from "./firewall-plan.js";
import { renderSquidConfig } from "./squid-config-rendering.js";

/** @lintignore Public semantic network lifecycle. */
export interface ContainerNetworkLifecycle {
  readonly failure: Promise<Error>;
}

const noNetworkFailure = new Promise<Error>(() => undefined);

export async function startContainerNetwork(
  request: NetworkBootstrapRequest,
  options: { readonly signal?: AbortSignal },
): Promise<ContainerNetworkLifecycle> {
  if (!request.enabled) return { failure: noNetworkFailure };
  const network = createContainerNetworkSystem({
    ...(options.signal ? { signal: options.signal } : {}),
  });
  await network.applyFirewall(buildFirewallPlan(request));
  if (!request.noProxy) {
    const upstreamDns = await network.discoverUpstreamDns();
    await network.startDnsmasq({
      config: renderDnsmasqConfig(request, upstreamDns),
    });
    await network.startSquid(renderSquidConfig(request));
  }
  await network.startNetworkTrace();
  return { failure: network.failure };
}
