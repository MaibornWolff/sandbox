import {
  createContainerNetworkSystem,
  writeSshProxyConfiguration,
} from "#platform/container-system/index.js";
import type { NetworkBootstrapRequest } from "./bootstrap-request-parsing.js";
import { renderDnsmasqConfig } from "./dnsmasq-config-rendering.js";
import { buildFirewallPlan, buildIpv6FirewallPlan } from "./firewall-plan.js";
import type { GuestHostMapping } from "./guest-host-mappings.js";
import { renderSquidConfig } from "./squid-config-rendering.js";

/** @lintignore Public semantic network lifecycle. */
export interface ContainerNetworkLifecycle {
  readonly readiness: Promise<void>;
  readonly failure: Promise<Error>;
}

const noNetworkFailure = new Promise<Error>(() => undefined);

export async function installContainerNetworkSecurity(
  request: NetworkBootstrapRequest,
  options: {
    readonly signal?: AbortSignal;
    readonly hostMappings: readonly GuestHostMapping[];
    readonly hostAccessName: string;
  },
): Promise<ContainerNetworkLifecycle> {
  const cancellation = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, cancellation.signal])
    : cancellation.signal;
  const network = createContainerNetworkSystem({ signal });
  await network.applyHostMappings(options.hostMappings);
  if (!request.enabled) {
    signal.throwIfAborted();
    if (!request.noProxy) writeSshProxyConfiguration();
    return { readiness: Promise.resolve(), failure: noNetworkFailure };
  }
  await network.applyFirewall(buildFirewallPlan(request));
  const upstreamDns = request.noProxy
    ? undefined
    : await network.discoverUpstreamDns();
  await network.applyIpv6Firewall(buildIpv6FirewallPlan(request, upstreamDns));
  const services: Promise<void>[] = [];
  const readiness = (async () => {
    try {
      if (!request.noProxy && upstreamDns) {
        const squid = renderSquidConfig(request);
        services.push(
          network.startDnsmasq({
            config: renderDnsmasqConfig(
              request,
              upstreamDns,
              options.hostMappings,
              options.hostAccessName,
            ),
          }),
        );
        services.push(network.startSquid(squid));
      }
      await Promise.race([
        Promise.all(services),
        network.failure.then((error) => {
          throw error;
        }),
      ]);
      signal.throwIfAborted();
      await network.startNetworkTrace();
      signal.throwIfAborted();
      if (!request.noProxy) writeSshProxyConfiguration();
    } catch (error) {
      cancellation.abort(error);
      await Promise.allSettled(services);
      throw error;
    }
  })();
  void readiness.catch(() => undefined);
  return { readiness, failure: network.failure };
}
