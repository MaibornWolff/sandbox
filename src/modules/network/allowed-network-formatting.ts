import {
  type AllowedNetwork,
  allowsAllNetworkPorts,
  isNetworkPort,
  mergeNetworkPortSelections,
  type NetworkPortSelection,
  networkPortSelectionIncludes,
} from "#modules/configuration/index.js";

/**
 * Deduplicate and format allowed network rules for display.
 * Merges ports across duplicate (wildcard, host) entries.
 * Returns sorted, formatted strings ready for display.
 */
export function mergeAllowedNetworks(rules: AllowedNetwork[]): string[] {
  const merged = new Map<
    string,
    { host: string; wildcard: boolean; ports: NetworkPortSelection }
  >();
  for (const rule of rules) {
    const host = canonicalizeHost(rule.host);
    const key = `${rule.wildcard ? "*" : ""}|${host}`;
    const entry = merged.get(key);
    merged.set(key, {
      host,
      wildcard: rule.wildcard,
      ports: mergeNetworkPortSelections(entry?.ports, effectivePorts(rule)),
    });
  }
  return [...merged.values()]
    .map((rule) =>
      formatNetworkDomain(
        rule.wildcard ? `*.${rule.host}` : rule.host,
        rule.ports,
      ),
    )
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Deduplicate AllowedNetwork rules for policy enforcement.
 * Merge only identical host identities so exact and wildcard rules can retain
 * different port selections.
 */
export function deduplicateAllowedNetworks(
  rules: AllowedNetwork[],
): AllowedNetwork[] {
  const merged = new Map<string, AllowedNetwork>();
  for (const rule of rules) {
    const host = canonicalizeHost(rule.host);
    const key = `${rule.wildcard ? "*." : ""}${host}`;
    const existing = merged.get(key);
    const ports = mergeNetworkPortSelections(
      existing ? effectivePorts(existing) : undefined,
      effectivePorts(rule),
    );
    merged.set(key, { host, wildcard: rule.wildcard, ports });
  }
  return [...merged.values()];
}

export const DEFAULT_NETWORK_PORTS: readonly number[] = [80, 443];

/**
 * Normalize host for matching: lowercase, strip trailing dots, strip IPv6 brackets.
 * @testonly
 */
export function canonicalizeHost(host: string): string {
  let h = host.toLowerCase();
  // Strip trailing dots
  while (h.endsWith(".")) {
    h = h.slice(0, -1);
  }
  // Strip IPv6 brackets
  if (h.startsWith("[") && h.endsWith("]")) {
    h = h.slice(1, -1);
  }
  return h;
}

/**
 * Check if a rule host matches a destination (exact or wildcard).
 * *.example.com matches example.com and sub.example.com (matching runtime behavior).
 * Both ruleHost and destHost are canonicalized before comparison.
 * @testonly
 */
export function hostMatches(ruleHost: string, destHost: string): boolean {
  const canonRule = canonicalizeHost(ruleHost);
  const canonDest = canonicalizeHost(destHost);

  if (canonRule.startsWith("*.")) {
    const baseHost = canonRule.slice(2);
    return canonDest === baseHost || canonDest.endsWith(`.${baseHost}`);
  }

  return canonRule === canonDest;
}

/**
 * Get effective ports from a rule, validating values (0 < p <= 65535).
 * Falls back to DEFAULT_NETWORK_PORTS if all ports invalid or empty.
 * @testonly
 */
export function effectivePorts(rule: AllowedNetwork): NetworkPortSelection {
  if (allowsAllNetworkPorts(rule.ports)) return rule.ports;
  const valid = rule.ports.filter(isNetworkPort);
  return valid.length === 0 ? [...DEFAULT_NETWORK_PORTS] : [...new Set(valid)];
}

function ruleCoversPort(
  rule: AllowedNetwork,
  domain: string,
  port: number,
): boolean {
  const ruleHost = rule.wildcard ? `*.${rule.host}` : rule.host;
  if (!hostMatches(ruleHost, domain)) return false;
  return networkPortSelectionIncludes(effectivePorts(rule), port);
}

/**
 * Return ports from requiredPorts not covered by any existing rule.
 */
export function getUncoveredPorts(
  domain: string,
  requiredPorts: Set<number>,
  existingRules: AllowedNetwork[],
): Set<number> {
  const uncovered = new Set<number>();

  for (const port of requiredPorts) {
    if (!existingRules.some((rule) => ruleCoversPort(rule, domain, port))) {
      uncovered.add(port);
    }
  }

  return uncovered;
}

/**
 * Check if a canonicalized host is a raw IP address (IPv4 or IPv6).
 */
function isRawIp(host: string): boolean {
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host.includes(":")) return true;
  return false;
}

/**
 * Group log entries by canonicalized destination, collecting non-zero ports.
 * Filters out raw IP addresses (IPv4 and IPv6).
 */
export function groupPortsByDomain(
  entries: { destination: string; port: number }[],
): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();

  for (const entry of entries) {
    const canonical = canonicalizeHost(entry.destination);
    if (!canonical || isRawIp(canonical)) continue;

    if (!result.has(canonical)) {
      result.set(canonical, new Set());
    }
    if (entry.port > 0) {
      result.get(canonical)?.add(entry.port);
    }
  }

  return result;
}

/**
 * Format domain+ports for config:
 *   {80,443} only or empty → "domain.com"
 *   {80,443,22} → "domain.com:{22,80,443}"
 *   {1234} alone → "domain.com:1234"
 *   {1234,5678} → "domain.com:{1234,5678}"
 */
export function formatNetworkDomain(
  domain: string,
  ports: ReadonlySet<number> | NetworkPortSelection,
): string {
  if (allowsAllNetworkPorts(ports)) return `${domain}:*`;
  const selectedPorts = new Set(ports);

  // Empty or exactly {80, 443}
  if (
    selectedPorts.size === 0 ||
    (selectedPorts.size === 2 &&
      selectedPorts.has(80) &&
      selectedPorts.has(443))
  ) {
    return domain;
  }

  const sorted = [...selectedPorts].sort((a, b) => a - b);

  if (sorted.length === 1) {
    return `${domain}:${sorted[0]}`;
  }

  return `${domain}:{${sorted.join(",")}}`;
}
