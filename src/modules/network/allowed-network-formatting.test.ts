import { describe, expect, test } from "bun:test";
import type { AllowedNetwork } from "#modules/configuration/index.js";
import {
  canonicalizeHost,
  DEFAULT_NETWORK_PORTS,
  deduplicateAllowedNetworks,
  effectivePorts,
  formatNetworkDomain,
  getUncoveredPorts,
  groupPortsByDomain,
  hostMatches,
  mergeAllowedNetworks,
} from "./allowed-network-formatting.js";

describe("canonicalizeHost", () => {
  test("lowercases host", () => {
    expect(canonicalizeHost("GitHub.COM")).toBe("github.com");
  });

  test("strips trailing dot", () => {
    expect(canonicalizeHost("example.com.")).toBe("example.com");
  });

  test("strips multiple trailing dots", () => {
    expect(canonicalizeHost("example.com...")).toBe("example.com");
  });

  test("strips IPv6 brackets", () => {
    expect(canonicalizeHost("[::1]")).toBe("::1");
  });

  test("already-clean input is returned unchanged", () => {
    expect(canonicalizeHost("api.github.com")).toBe("api.github.com");
  });
});

describe("hostMatches", () => {
  test("exact match returns true", () => {
    expect(hostMatches("github.com", "github.com")).toBe(true);
  });

  test("wildcard matches subdomain", () => {
    expect(hostMatches("*.github.com", "api.github.com")).toBe(true);
  });

  test("wildcard matches apex", () => {
    expect(hostMatches("*.github.com", "github.com")).toBe(true);
  });

  test("non-match returns false", () => {
    expect(hostMatches("github.com", "evil.com")).toBe(false);
  });

  test("matching is case-insensitive", () => {
    expect(hostMatches("GitHub.COM", "github.com")).toBe(true);
  });

  test("wildcard matches deep subdomains", () => {
    expect(hostMatches("*.github.com", "a.b.github.com")).toBe(true);
  });
});

describe("effectivePorts", () => {
  test("returns valid ports from rule", () => {
    const rule: AllowedNetwork = {
      host: "example.com",
      ports: [22, 443],
      wildcard: false,
    };
    expect(effectivePorts(rule)).toEqual([22, 443]);
  });

  test("empty ports falls back to defaults", () => {
    const rule: AllowedNetwork = {
      host: "example.com",
      ports: [],
      wildcard: false,
    };
    expect(effectivePorts(rule)).toEqual([...DEFAULT_NETWORK_PORTS]);
  });

  test("all-invalid ports falls back to defaults", () => {
    const rule: AllowedNetwork = {
      host: "example.com",
      ports: [0, -1, 99999],
      wildcard: false,
    };
    expect(effectivePorts(rule)).toEqual([...DEFAULT_NETWORK_PORTS]);
  });

  test("partially valid ports keeps only valid ones", () => {
    const rule: AllowedNetwork = {
      host: "example.com",
      ports: [22, 0, 443, -1, 65536],
      wildcard: false,
    };
    expect(effectivePorts(rule)).toEqual([22, 443]);
  });

  test("preserves the all-port selection", () => {
    expect(
      effectivePorts({ host: "example.com", ports: "*", wildcard: false }),
    ).toBe("*");
  });
});

describe("getUncoveredPorts", () => {
  test("fully covered returns empty set", () => {
    const rules: AllowedNetwork[] = [
      { host: "github.com", ports: [80, 443], wildcard: false },
    ];
    const uncovered = getUncoveredPorts(
      "github.com",
      new Set([80, 443]),
      rules,
    );
    expect(uncovered.size).toBe(0);
  });

  test("partially covered returns only uncovered ports", () => {
    const rules: AllowedNetwork[] = [
      { host: "github.com", ports: [443], wildcard: false },
    ];
    const uncovered = getUncoveredPorts(
      "github.com",
      new Set([22, 443]),
      rules,
    );
    expect(uncovered.has(22)).toBe(true);
    expect(uncovered.has(443)).toBe(false);
  });

  test("no rules match returns all required ports", () => {
    const uncovered = getUncoveredPorts("github.com", new Set([80, 443]), []);
    expect(uncovered.has(80)).toBe(true);
    expect(uncovered.has(443)).toBe(true);
  });

  test("wildcard rule covers subdomains", () => {
    const rules: AllowedNetwork[] = [
      { host: "github.com", ports: [443], wildcard: true },
    ];
    const uncovered = getUncoveredPorts(
      "api.github.com",
      new Set([443]),
      rules,
    );
    expect(uncovered.size).toBe(0);
  });

  test("wildcard rule covers apex domain", () => {
    const rules: AllowedNetwork[] = [
      { host: "github.com", ports: [443], wildcard: true },
    ];
    const uncovered = getUncoveredPorts("github.com", new Set([443]), rules);
    expect(uncovered.size).toBe(0);
  });

  test("all-port exact rule covers every required port", () => {
    const rules: AllowedNetwork[] = [
      { host: "github.com", ports: "*", wildcard: false },
    ];
    expect(
      getUncoveredPorts("github.com", new Set([22, 443, 8443]), rules),
    ).toEqual(new Set());
  });

  test("all-port wildcard rule covers every subdomain port", () => {
    const rules: AllowedNetwork[] = [
      { host: "github.com", ports: "*", wildcard: true },
    ];
    expect(
      getUncoveredPorts("api.github.com", new Set([1, 65535]), rules),
    ).toEqual(new Set());
  });

  test("empty required ports returns empty set", () => {
    const rules: AllowedNetwork[] = [
      { host: "github.com", ports: [443], wildcard: false },
    ];
    const uncovered = getUncoveredPorts("github.com", new Set(), rules);
    expect(uncovered.size).toBe(0);
  });
});

describe("groupPortsByDomain", () => {
  test("groups multiple entries by domain, merging ports", () => {
    const entries = [
      { destination: "github.com", port: 443 },
      { destination: "github.com", port: 80 },
      { destination: "api.stripe.com", port: 443 },
    ];
    const result = groupPortsByDomain(entries);
    expect(result.get("github.com")).toEqual(new Set([443, 80]));
    expect(result.get("api.stripe.com")).toEqual(new Set([443]));
  });

  test("port-0 DNS entries produce an empty port set", () => {
    const entries = [{ destination: "github.com", port: 0 }];
    const result = groupPortsByDomain(entries);
    expect(result.get("github.com")).toEqual(new Set());
  });

  test("raw IPv4 addresses are filtered out", () => {
    const entries = [{ destination: "8.8.8.8", port: 443 }];
    const result = groupPortsByDomain(entries);
    expect(result.size).toBe(0);
  });

  test("raw IPv6 addresses are filtered out", () => {
    const entries = [{ destination: "2001:db8::1", port: 443 }];
    const result = groupPortsByDomain(entries);
    expect(result.size).toBe(0);
  });

  test("canonicalizes domain names before grouping", () => {
    const entries = [
      { destination: "GitHub.COM", port: 443 },
      { destination: "github.com", port: 80 },
    ];
    const result = groupPortsByDomain(entries);
    expect(result.size).toBe(1);
    expect(result.get("github.com")).toEqual(new Set([443, 80]));
  });

  test("empty destination string is filtered out", () => {
    const entries = [{ destination: "", port: 443 }];
    const result = groupPortsByDomain(entries);
    expect(result.size).toBe(0);
  });
});

describe("mergeAllowedNetworks", () => {
  test("empty input returns empty array", () => {
    expect(mergeAllowedNetworks([])).toEqual([]);
  });

  test("single rule with default ports returns bare domain", () => {
    const rules: AllowedNetwork[] = [
      { host: "github.com", ports: [], wildcard: false },
    ];
    expect(mergeAllowedNetworks(rules)).toEqual(["github.com"]);
  });

  test("duplicate exact-match rules for same host are deduplicated", () => {
    const rules: AllowedNetwork[] = [
      { host: "github.com", ports: [], wildcard: false },
      { host: "github.com", ports: [], wildcard: false },
    ];
    expect(mergeAllowedNetworks(rules)).toEqual(["github.com"]);
  });

  test("duplicate wildcard rules are deduplicated", () => {
    const rules: AllowedNetwork[] = [
      { host: "github.com", ports: [], wildcard: true },
      { host: "github.com", ports: [], wildcard: true },
    ];
    expect(mergeAllowedNetworks(rules)).toEqual(["*.github.com"]);
  });

  test("wildcard and exact-match for same host are kept as separate entries", () => {
    const rules: AllowedNetwork[] = [
      { host: "github.com", ports: [], wildcard: false },
      { host: "github.com", ports: [], wildcard: true },
    ];
    const result = mergeAllowedNetworks(rules);
    expect(result).toContain("github.com");
    expect(result).toContain("*.github.com");
    expect(result).toHaveLength(2);
  });

  test("ports are merged across duplicate rules", () => {
    const rules: AllowedNetwork[] = [
      { host: "example.com", ports: [22], wildcard: false },
      { host: "example.com", ports: [443], wildcard: false },
    ];
    expect(mergeAllowedNetworks(rules)).toEqual(["example.com:{22,443}"]);
  });

  test("all ports dominate explicit ports for a duplicate identity", () => {
    const rules: AllowedNetwork[] = [
      { host: "example.com", ports: [443], wildcard: false },
      { host: "example.com", ports: "*", wildcard: false },
      { host: "example.com", ports: [22], wildcard: false },
    ];
    expect(mergeAllowedNetworks(rules)).toEqual(["example.com:*"]);
  });

  test("canonical all-port formatting preserves wildcard host identity", () => {
    expect(
      mergeAllowedNetworks([
        { host: "example.com", ports: "*", wildcard: true },
      ]),
    ).toEqual(["*.example.com:*"]);
  });

  test("host comparison is case-insensitive", () => {
    const rules: AllowedNetwork[] = [
      { host: "GitHub.COM", ports: [], wildcard: false },
      { host: "github.com", ports: [], wildcard: false },
    ];
    expect(mergeAllowedNetworks(rules)).toEqual(["github.com"]);
  });

  test("output is sorted alphabetically", () => {
    const rules: AllowedNetwork[] = [
      { host: "stripe.com", ports: [], wildcard: false },
      { host: "anthropic.com", ports: [], wildcard: false },
      { host: "github.com", ports: [], wildcard: false },
    ];
    expect(mergeAllowedNetworks(rules)).toEqual([
      "anthropic.com",
      "github.com",
      "stripe.com",
    ]);
  });

  test("ports {80,443} produce bare domain after merge", () => {
    const rules: AllowedNetwork[] = [
      { host: "example.com", ports: [80], wildcard: false },
      { host: "example.com", ports: [443], wildcard: false },
    ];
    expect(mergeAllowedNetworks(rules)).toEqual(["example.com"]);
  });
});

describe("formatNetworkDomain", () => {
  test("empty ports returns bare domain", () => {
    expect(formatNetworkDomain("example.com", new Set())).toBe("example.com");
  });

  test("{80,443} returns bare domain", () => {
    expect(formatNetworkDomain("example.com", new Set([80, 443]))).toBe(
      "example.com",
    );
  });

  test("all ports return canonical domain:*", () => {
    expect(formatNetworkDomain("example.com", "*")).toBe("example.com:*");
  });

  test("single non-default port returns domain:port", () => {
    expect(formatNetworkDomain("example.com", new Set([22]))).toBe(
      "example.com:22",
    );
  });

  test("multiple non-default ports returns domain:{ports}", () => {
    expect(formatNetworkDomain("example.com", new Set([1234, 5678]))).toBe(
      "example.com:{1234,5678}",
    );
  });

  test("{80,443,22} returns domain:{22,80,443}", () => {
    expect(formatNetworkDomain("example.com", new Set([80, 443, 22]))).toBe(
      "example.com:{22,80,443}",
    );
  });

  test("single port 80 alone returns domain:80, not bare domain", () => {
    expect(formatNetworkDomain("example.com", new Set([80]))).toBe(
      "example.com:80",
    );
  });

  test("single port 443 alone returns domain:443, not bare domain", () => {
    expect(formatNetworkDomain("example.com", new Set([443]))).toBe(
      "example.com:443",
    );
  });
});

describe("deduplicateAllowedNetworks", () => {
  test("preserves an exact domain overlapped by a wildcard domain", () => {
    const rules: AllowedNetwork[] = [
      { host: "anthropic.com", ports: [443], wildcard: true },
      { host: "api.anthropic.com", ports: [22], wildcard: false },
    ];
    expect(deduplicateAllowedNetworks(rules)).toEqual(rules);
  });

  test("keeps exact and wildcard identities for the same base domain", () => {
    const rules: AllowedNetwork[] = [
      { host: "anthropic.com", ports: [443], wildcard: true },
      { host: "anthropic.com", ports: [22], wildcard: false },
    ];
    expect(deduplicateAllowedNetworks(rules)).toEqual(rules);
  });

  test("keeps non-wildcard domain not covered by any wildcard", () => {
    const rules: AllowedNetwork[] = [
      { host: "anthropic.com", ports: [80, 443], wildcard: true },
      { host: "github.com", ports: [22, 80, 443], wildcard: false },
    ];
    const result = deduplicateAllowedNetworks(rules);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({
      host: "anthropic.com",
      ports: [80, 443],
      wildcard: true,
    });
    expect(result).toContainEqual({
      host: "github.com",
      ports: [22, 80, 443],
      wildcard: false,
    });
  });

  test("merges ports for duplicate host+wildcard pairs", () => {
    const rules: AllowedNetwork[] = [
      { host: "github.com", ports: [80, 443], wildcard: false },
      { host: "github.com", ports: [22], wildcard: false },
    ];
    const result = deduplicateAllowedNetworks(rules);
    expect(result).toHaveLength(1);
    expect(result[0]?.host).toBe("github.com");
    expect(result[0]?.ports).toEqual(expect.arrayContaining([22, 80, 443]));
  });

  test("all ports dominate explicit ports for duplicate identities", () => {
    const rules: AllowedNetwork[] = [
      { host: "example.com", ports: [443], wildcard: false },
      { host: "example.com", ports: "*", wildcard: false },
      { host: "example.com", ports: [22], wildcard: false },
    ];
    expect(deduplicateAllowedNetworks(rules)).toEqual([
      { host: "example.com", ports: "*", wildcard: false },
    ]);
  });

  test("returns empty array for empty input", () => {
    expect(deduplicateAllowedNetworks([])).toEqual([]);
  });

  test("canonicalizes hosts during dedup without dropping identities", () => {
    const rules: AllowedNetwork[] = [
      { host: "Anthropic.COM", ports: [443], wildcard: true },
      { host: "API.ANTHROPIC.COM", ports: [443], wildcard: false },
    ];
    const result = deduplicateAllowedNetworks(rules);
    expect(result.map(({ host }) => host)).toEqual([
      "anthropic.com",
      "api.anthropic.com",
    ]);
  });
});
