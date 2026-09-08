import type {
  NetworkConnectionStatus,
  NetworkDiagnostic,
  NetworkLogEntry,
} from "./network-diagnostics.js";

export interface RawDiagnosticSection {
  readonly title: string;
  readonly diagnostic: NetworkDiagnostic;
  readonly tone: "blue" | "cyan" | "magenta" | "red" | "yellow";
}

export function prepareNetworkLogEntries(
  entries: readonly NetworkLogEntry[],
  options: { readonly showAllowed: boolean },
): NetworkLogEntry[] {
  const aggregated = new Map<string, NetworkLogEntry>();
  for (const entry of entries) {
    const key = `${entry.container}:${entry.destination}:${entry.port}:${entry.status}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.count += entry.count;
      existing.lastSeen = Math.max(existing.lastSeen, entry.lastSeen);
    } else {
      aggregated.set(key, { ...entry });
    }
  }
  return [...aggregated.values()]
    .filter(
      (entry) =>
        options.showAllowed ||
        entry.status !== ("ALLOWED" satisfies NetworkConnectionStatus),
    )
    .sort((left, right) => right.lastSeen - left.lastSeen);
}

export function buildRawDiagnosticSections(diagnostics: {
  readonly runtimeLog: NetworkDiagnostic;
  readonly networkState: NetworkDiagnostic;
  readonly firewall: NetworkDiagnostic;
  readonly dns: NetworkDiagnostic;
  readonly proxyAccess: NetworkDiagnostic;
  readonly proxyCache: NetworkDiagnostic;
}): readonly RawDiagnosticSection[] {
  return [
    {
      title: "CONTAINER LOG (last 200 lines)",
      diagnostic: diagnostics.runtimeLog,
      tone: "magenta",
    },
    {
      title: "NETWORK STATE",
      diagnostic: diagnostics.networkState,
      tone: "yellow",
    },
    {
      title: "FIREWALL LOG (iptables/NFLOG)",
      diagnostic: diagnostics.firewall,
      tone: "red",
    },
    { title: "DNS LOG (dnsmasq)", diagnostic: diagnostics.dns, tone: "cyan" },
    {
      title: "PROXY ACCESS LOG (Squid)",
      diagnostic: diagnostics.proxyAccess,
      tone: "blue",
    },
    {
      title: "PROXY CACHE LOG (Squid)",
      diagnostic: diagnostics.proxyCache,
      tone: "magenta",
    },
  ];
}
