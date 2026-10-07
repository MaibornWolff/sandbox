import type { NetworkBootstrapRequest } from "./bootstrap-request-parsing.js";
import type { GuestHostMapping } from "./guest-host-mappings.js";

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
  hostMappings: readonly GuestHostMapping[],
  hostAccessName: string,
): string {
  if (!upstreamDns.trim()) throw new Error("No upstream DNS server found");
  const exactRecords = hostMappings.map(
    ({ host, address }) => `host-record=${host},${address}`,
  );
  const mappedHosts = new Set(hostMappings.map(({ host }) => host));
  const hostForwarding = mappedHosts.has(hostAccessName)
    ? []
    : [`server=/${hostAccessName}/${upstreamDns}`];
  if (request.fullNetwork) {
    return `${DNSMASQ_BASE}${exactRecords.join("\n")}${exactRecords.length ? "\n" : ""}server=/#/${upstreamDns}\n`;
  }
  const forwardingRules = [
    ...hostForwarding,
    ...[...new Set(request.allowNetwork.map(({ host }) => host))].map(
      (host) => `server=/${host}/${upstreamDns}`,
    ),
  ];
  return `${DNSMASQ_BASE}${exactRecords.join("\n")}${exactRecords.length ? "\n" : ""}${forwardingRules.join("\n")}\naddress=/#/\n`;
}
