import type { ContainerRuntime } from "#platform/container-runtime/index.js";
import { aggregateBlocked, parseBlockedLog } from "./blocked-log-parsing.js";
import {
  buildContainerDiagnosticCommand,
  type NetworkDiagnosticSource,
} from "./container-diagnostic-commands.js";
import type { NetworkContainer } from "./container-discovery.js";
import {
  buildIpToDomainMap,
  parseDnsAllowedDomains,
  parseDnsBlockedDomains,
  parseDnsLog,
} from "./dns-log-parsing.js";
import { reverseLookupBatch } from "./dns-resolution.js";
import type {
  NetworkConnectionStatus,
  NetworkLogEntry,
} from "./network-diagnostics.js";
import { aggregateProxyLog, parseProxyLog } from "./proxy-log-parsing.js";

async function readContainerLog(
  service: ContainerRuntime,
  containerId: string,
  source: NetworkDiagnosticSource,
): Promise<string | null> {
  try {
    return await service.execInContainer(
      containerId,
      buildContainerDiagnosticCommand(source),
      { user: "root" },
    );
  } catch {
    return null;
  }
}

async function buildHostnameMap(
  ips: string[],
  dnsMappings: Map<string, string>,
  useReverseDns: boolean,
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const unmappedIps: string[] = [];

  for (const ip of ips) {
    const domain = dnsMappings.get(ip);
    if (domain) result.set(ip, domain);
    else unmappedIps.push(ip);
  }

  if (useReverseDns && unmappedIps.length > 0) {
    const reverseDns = await reverseLookupBatch(unmappedIps);
    for (const [ip, hostname] of reverseDns) {
      if (!result.has(ip)) result.set(ip, hostname);
    }
  }

  return result;
}

function parseLogEntries(
  log: string,
  container: NetworkContainer,
  hostnames: Map<string, string | null>,
  status: NetworkConnectionStatus,
): NetworkLogEntry[] {
  const requests = parseBlockedLog(log);
  if (requests.length === 0) return [];

  return aggregateBlocked(requests).map((entry) => ({
    container: container.id,
    image: container.image,
    destination: hostnames.get(entry.dstIp) || entry.dstIp,
    dstIp: entry.dstIp,
    port: entry.dstPort,
    count: entry.count,
    lastSeen: entry.lastSeen,
    status,
  }));
}

function addDnsEntries(
  entries: NetworkLogEntry[],
  container: NetworkContainer,
  dnsEntries: Array<{ domain: string; count: number; lastSeen: number }>,
  skipDomains: Set<string>,
  status: NetworkConnectionStatus,
): void {
  for (const entry of dnsEntries) {
    if (skipDomains.has(entry.domain)) continue;
    entries.push({
      container: container.id,
      image: container.image,
      destination: entry.domain,
      dstIp: "",
      port: 0,
      count: entry.count,
      lastSeen: entry.lastSeen,
      status,
    });
  }
}

export async function collectContainerEntries(
  service: ContainerRuntime,
  container: NetworkContainer,
  useReverseDns: boolean,
  referenceTime: number,
): Promise<NetworkLogEntry[]> {
  const [blockedLog, dnsLog, proxyLog] = await Promise.all([
    readContainerLog(service, container.id, "firewall"),
    readContainerLog(service, container.id, "dns"),
    readContainerLog(service, container.id, "proxy-access"),
  ]);
  const dnsMappings = buildIpToDomainMap(
    parseDnsLog(dnsLog ?? "", referenceTime),
  );
  const blockedRequests = parseBlockedLog(blockedLog ?? "");
  const allIps = [...new Set(blockedRequests.map((request) => request.dstIp))];
  const hostnames = await buildHostnameMap(allIps, dnsMappings, useReverseDns);
  const entries: NetworkLogEntry[] = [
    ...parseLogEntries(blockedLog ?? "", container, hostnames, "BLOCKED"),
  ];
  const proxyEntries = aggregateProxyLog(parseProxyLog(proxyLog ?? ""));

  for (const entry of proxyEntries) {
    entries.push({
      container: container.id,
      image: container.image,
      destination: entry.domain,
      dstIp: "",
      port: entry.port,
      count: entry.count,
      lastSeen: entry.lastSeen,
      status: entry.status === "allowed" ? "ALLOWED" : "BLOCKED",
    });
  }

  const dnsBlocked = parseDnsBlockedDomains(dnsLog ?? "", referenceTime);
  const proxyBlockedDomains = new Set(
    proxyEntries
      .filter((entry) => entry.status === "denied")
      .map((entry) => entry.domain),
  );
  addDnsEntries(entries, container, dnsBlocked, proxyBlockedDomains, "BLOCKED");

  const dnsAllowed = parseDnsAllowedDomains(dnsLog ?? "", referenceTime);
  const proxyDomains = new Set(proxyEntries.map((entry) => entry.domain));
  addDnsEntries(entries, container, dnsAllowed, proxyDomains, "ALLOWED");
  return entries;
}
