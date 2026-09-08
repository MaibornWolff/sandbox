import type { NetworkBootstrapRequest } from "./bootstrap-request-parsing.js";

const DNSMASQ_BASE = `no-resolv
listen-address=127.0.0.1
bind-interfaces
user=dnsmasq

# Burst-load tuning
dns-forward-max=1000
cache-size=10000
no-negcache
log-queries
log-facility=/var/log/dns-proxy.log
`;

/** @testonly */
export function renderDnsmasqConfig(
  request: NetworkBootstrapRequest,
  upstreamDns: string,
): string {
  if (!upstreamDns.trim()) throw new Error("No upstream DNS server found");
  if (request.fullNetwork) {
    return `${DNSMASQ_BASE}server=/#/${upstreamDns}\n`;
  }
  const internalHosts = [
    "host.docker.internal",
    "host.lima.internal",
    "host.containers.internal",
  ];
  const forwardingRules = [
    ...internalHosts,
    ...new Set(request.allowNetwork.map(({ host }) => host)),
  ].map((host) => `server=/${host}/${upstreamDns}`);
  return `${DNSMASQ_BASE}${forwardingRules.join("\n")}\naddress=/#/\n`;
}
