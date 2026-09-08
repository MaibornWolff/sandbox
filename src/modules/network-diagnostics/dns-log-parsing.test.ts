import { describe, expect, test } from "bun:test";
import {
  buildIpToDomainMap,
  parseDnsAllowedDomains as parseDnsAllowedDomainsAt,
  parseDnsBlockedDomains as parseDnsBlockedDomainsAt,
  parseDnsLog as parseDnsLogAt,
} from "./dns-log-parsing.js";

const referenceTime = Date.UTC(2026, 0, 1);
const parseDnsLog = (raw: string) => parseDnsLogAt(raw, referenceTime);
const parseDnsBlockedDomains = (raw: string) =>
  parseDnsBlockedDomainsAt(raw, referenceTime);
const parseDnsAllowedDomains = (raw: string) =>
  parseDnsAllowedDomainsAt(raw, referenceTime);

describe("parseDnsLog", () => {
  test("parses valid dnsmasq DNS output", () => {
    const raw = `Jan 15 10:30:00 dnsmasq[123]: reply google.de is 142.251.20.67
Jan 15 10:30:01 dnsmasq[123]: reply api.stripe.com is 104.18.27.120
Jan 15 10:30:01 dnsmasq[123]: reply api.stripe.com is 104.18.28.120`;

    const result = parseDnsLog(raw);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      timestamp: expect.any(Number),
      domain: "google.de",
      ip: "142.251.20.67",
    });
    expect(result[1]).toEqual({
      timestamp: expect.any(Number),
      domain: "api.stripe.com",
      ip: "104.18.27.120",
    });
    expect(result[2]).toEqual({
      timestamp: expect.any(Number),
      domain: "api.stripe.com",
      ip: "104.18.28.120",
    });
  });

  test("parses real syslog timestamps", () => {
    const raw = `Jan 15 10:30:00 dnsmasq[123]: reply example.com is 1.2.3.4`;

    const result = parseDnsLog(raw);

    expect(result).toHaveLength(1);
    // Should be a real timestamp (ms since epoch), not a line index
    const year = new Date(referenceTime).getUTCFullYear();
    const expected = new Date(`Jan 15 10:30:00 ${year} UTC`).getTime();
    expect(result[0]?.timestamp).toBe(expected);
  });

  test("returns empty array for empty input", () => {
    expect(parseDnsLog("")).toEqual([]);
  });

  test("returns empty array for whitespace-only input", () => {
    expect(parseDnsLog("   \n\t\n  ")).toEqual([]);
  });

  test("skips malformed lines", () => {
    const raw = `Jan 15 10:30:00 dnsmasq[123]: reply google.de is 142.251.20.67
incomplete line without reply keyword
missing reply format
Jan 15 10:30:01 dnsmasq[123]: reply valid.com is 1.2.3.4`;

    const result = parseDnsLog(raw);

    expect(result).toHaveLength(2);
    expect(result.find((r) => r.domain === "google.de")).toBeDefined();
    expect(result.find((r) => r.domain === "valid.com")).toBeDefined();
  });

  test("normalizes domain to lowercase", () => {
    const raw = `Jan 15 10:30:00 dnsmasq[123]: reply GOOGLE.DE is 142.251.20.67`;

    const result = parseDnsLog(raw);

    expect(result[0]?.domain).toBe("google.de");
  });

  test("handles multiple IPs (multiple A records)", () => {
    const raw = `Jan 15 10:30:00 dnsmasq[123]: reply cdn.example.com is 1.1.1.1
Jan 15 10:30:00 dnsmasq[123]: reply cdn.example.com is 2.2.2.2
Jan 15 10:30:00 dnsmasq[123]: reply cdn.example.com is 3.3.3.3`;

    const result = parseDnsLog(raw);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      timestamp: expect.any(Number),
      domain: "cdn.example.com",
      ip: "1.1.1.1",
    });
    expect(result[1]).toEqual({
      timestamp: expect.any(Number),
      domain: "cdn.example.com",
      ip: "2.2.2.2",
    });
    expect(result[2]).toEqual({
      timestamp: expect.any(Number),
      domain: "cdn.example.com",
      ip: "3.3.3.3",
    });
  });

  test("later entries have equal or greater timestamps", () => {
    const raw = `Jan 15 10:30:00 dnsmasq[123]: reply domaina.com is 1.1.1.1
Jan 15 10:30:01 dnsmasq[123]: reply domainb.com is 2.2.2.2
Jan 15 10:30:02 dnsmasq[123]: reply domaina.com is 1.1.1.2`;

    const result = parseDnsLog(raw);

    const domainAFirst = result.find(
      (r) => r.domain === "domaina.com" && r.ip === "1.1.1.1",
    );
    const domainB = result.find((r) => r.domain === "domainb.com");
    const domainASecond = result.find(
      (r) => r.domain === "domaina.com" && r.ip === "1.1.1.2",
    );

    expect(domainAFirst).toBeDefined();
    expect(domainB).toBeDefined();
    expect(domainASecond).toBeDefined();

    if (domainAFirst && domainB && domainASecond) {
      expect(domainASecond.timestamp).toBeGreaterThan(domainB.timestamp);
    }
  });

  test("shared IP resolves to most recent domain", () => {
    const raw = `Jan 15 10:30:00 dnsmasq[123]: reply a.com is 1.1.1.1
Jan 15 10:30:01 dnsmasq[123]: reply b.com is 1.1.1.1`;

    const result = parseDnsLog(raw);
    const ipToDomain = buildIpToDomainMap(result);

    expect(ipToDomain.get("1.1.1.1")).toBe("b.com");
  });

  test("repeated domain does not refresh stale IPs", () => {
    const raw = `Jan 15 10:30:00 dnsmasq[123]: reply a.com is 1.1.1.1
Jan 15 10:30:01 dnsmasq[123]: reply b.com is 1.1.1.1
Jan 15 10:30:02 dnsmasq[123]: reply a.com is 2.2.2.2`;

    const result = parseDnsLog(raw);
    const ipToDomain = buildIpToDomainMap(result);

    expect(ipToDomain.get("1.1.1.1")).toBe("b.com");
    expect(ipToDomain.get("2.2.2.2")).toBe("a.com");
  });
});

describe("parseDnsBlockedDomains", () => {
  test("parses blocked domains from config lines with NXDOMAIN", () => {
    const raw = `Feb 16 14:11:39 dnsmasq[123]: config evil.com is NXDOMAIN
Feb 16 14:11:40 dnsmasq[123]: config malware.org is NXDOMAIN`;

    const result = parseDnsBlockedDomains(raw);

    expect(result).toHaveLength(2);
    expect(result.find((r) => r.domain === "evil.com")).toEqual({
      domain: "evil.com",
      count: 1,
      lastSeen: expect.any(Number),
    });
    expect(result.find((r) => r.domain === "malware.org")).toEqual({
      domain: "malware.org",
      count: 1,
      lastSeen: expect.any(Number),
    });
  });

  test("parses blocked domains with 0.0.0.0 response", () => {
    const raw = `Feb 16 14:11:39 dnsmasq[123]: config evil.com is 0.0.0.0`;

    const result = parseDnsBlockedDomains(raw);

    expect(result).toHaveLength(1);
    expect(result[0]?.domain).toBe("evil.com");
  });

  test("aggregates counts for same domain", () => {
    const raw = `Feb 16 14:11:39 dnsmasq[123]: config evil.com is NXDOMAIN
Feb 16 14:11:40 dnsmasq[123]: config evil.com is NXDOMAIN
Feb 16 14:11:41 dnsmasq[123]: config evil.com is NXDOMAIN`;

    const result = parseDnsBlockedDomains(raw);

    expect(result).toHaveLength(1);
    expect(result[0]?.count).toBe(3);
  });

  test("tracks most recent timestamp", () => {
    const raw = `Feb 16 14:11:39 dnsmasq[123]: config evil.com is NXDOMAIN
Feb 16 14:11:45 dnsmasq[123]: config evil.com is NXDOMAIN`;

    const result = parseDnsBlockedDomains(raw);

    expect(result).toHaveLength(1);
    const entry = result[0];
    const expectedLater = new Date(
      `Feb 16 14:11:45 ${new Date(referenceTime).getUTCFullYear()} UTC`,
    ).getTime();
    expect(entry?.lastSeen).toBe(expectedLater);
  });

  test("matches IPv6 block (::)", () => {
    const raw = `Feb 16 14:11:39 dnsmasq[123]: config evil.com is ::`;

    const result = parseDnsBlockedDomains(raw);

    expect(result).toHaveLength(1);
    expect(result[0]?.domain).toBe("evil.com");
  });

  test("normalizes domain to lowercase", () => {
    const raw = `Feb 16 14:11:39 dnsmasq[123]: config EVIL.COM is NXDOMAIN`;

    const result = parseDnsBlockedDomains(raw);

    expect(result).toHaveLength(1);
    expect(result[0]?.domain).toBe("evil.com");
  });

  test("ignores reply lines", () => {
    const raw = `Feb 16 14:11:39 dnsmasq[123]: reply github.com is 140.82.121.4
Feb 16 14:11:39 dnsmasq[123]: config evil.com is NXDOMAIN`;

    const result = parseDnsBlockedDomains(raw);

    expect(result).toHaveLength(1);
    expect(result[0]?.domain).toBe("evil.com");
  });

  test("returns empty array for empty input", () => {
    expect(parseDnsBlockedDomains("")).toEqual([]);
  });

  test("returns empty array when no blocked entries", () => {
    const raw = `Feb 16 14:11:39 dnsmasq[123]: reply github.com is 140.82.121.4
Feb 16 14:11:39 dnsmasq[123]: forwarded github.com to 10.0.2.3`;

    expect(parseDnsBlockedDomains(raw)).toEqual([]);
  });
});

describe("parseDnsAllowedDomains", () => {
  test("parses reply lines into allowed entries", () => {
    const raw = `Jan 15 10:30:00 dnsmasq[123]: reply github.com is 140.82.121.4
Jan 15 10:30:01 dnsmasq[123]: reply api.stripe.com is 104.18.27.120`;

    const result = parseDnsAllowedDomains(raw);

    expect(result).toHaveLength(2);
    expect(result.find((r) => r.domain === "github.com")).toEqual({
      domain: "github.com",
      count: 1,
      lastSeen: expect.any(Number),
    });
    expect(result.find((r) => r.domain === "api.stripe.com")).toEqual({
      domain: "api.stripe.com",
      count: 1,
      lastSeen: expect.any(Number),
    });
  });

  test("aggregates counts for same domain with multiple IPs", () => {
    const raw = `Jan 15 10:30:00 dnsmasq[123]: reply example.com is 1.1.1.1
Jan 15 10:30:00 dnsmasq[123]: reply example.com is 2.2.2.2
Jan 15 10:30:01 dnsmasq[123]: reply example.com is 3.3.3.3`;

    const result = parseDnsAllowedDomains(raw);

    expect(result).toHaveLength(1);
    expect(result[0]?.count).toBe(3);
  });

  test("tracks most recent timestamp", () => {
    const raw = `Jan 15 10:30:00 dnsmasq[123]: reply example.com is 1.1.1.1
Jan 15 10:30:05 dnsmasq[123]: reply example.com is 2.2.2.2`;

    const result = parseDnsAllowedDomains(raw);

    expect(result).toHaveLength(1);
    const expected = new Date(
      `Jan 15 10:30:05 ${new Date(referenceTime).getUTCFullYear()} UTC`,
    ).getTime();
    expect(result[0]?.lastSeen).toBe(expected);
  });

  test("normalizes domain to lowercase", () => {
    const raw = `Jan 15 10:30:00 dnsmasq[123]: reply GITHUB.COM is 140.82.121.4`;

    const result = parseDnsAllowedDomains(raw);

    expect(result).toHaveLength(1);
    expect(result[0]?.domain).toBe("github.com");
  });

  test("skips CNAME reply lines (value is a domain, not an IP)", () => {
    const raw = `Jan 15 10:30:00 dnsmasq[123]: reply www.example.com is example.com
Jan 15 10:30:00 dnsmasq[123]: reply example.com is 1.2.3.4`;

    const result = parseDnsAllowedDomains(raw);

    expect(result).toHaveLength(1);
    expect(result[0]?.domain).toBe("example.com");
  });

  test("skips reply values that start with digits but are not IPs", () => {
    const raw = `Jan 15 10:30:00 dnsmasq[123]: reply www.google.com is 1e100.net
Jan 15 10:30:01 dnsmasq[123]: reply google.com is 142.250.72.14`;

    const result = parseDnsAllowedDomains(raw);

    expect(result).toHaveLength(1);
    expect(result[0]?.domain).toBe("google.com");
  });

  test("includes IPv6 replies", () => {
    const raw = `Jan 15 10:30:00 dnsmasq[123]: reply github.com is 2606:50c0:8000::153`;

    const result = parseDnsAllowedDomains(raw);

    expect(result).toHaveLength(1);
    expect(result[0]?.domain).toBe("github.com");
  });

  test("ignores config/query/forwarded lines", () => {
    const raw = `Jan 15 10:30:00 dnsmasq[123]: config evil.com is NXDOMAIN
Jan 15 10:30:00 dnsmasq[123]: query[A] github.com from 172.17.0.2
Jan 15 10:30:00 dnsmasq[123]: forwarded github.com to 8.8.8.8`;

    const result = parseDnsAllowedDomains(raw);

    expect(result).toHaveLength(0);
  });

  test("returns empty array for empty input", () => {
    expect(parseDnsAllowedDomains("")).toEqual([]);
  });
});

describe("buildIpToDomainMap", () => {
  test("builds IP to domain mapping", () => {
    const mappings = [
      { timestamp: 1000, domain: "google.de", ip: "142.251.20.67" },
      { timestamp: 2000, domain: "stripe.com", ip: "104.18.27.120" },
    ];

    const result = buildIpToDomainMap(mappings);

    expect(result.get("142.251.20.67")).toBe("google.de");
    expect(result.get("104.18.27.120")).toBe("stripe.com");
  });

  test("uses most recent domain for same IP", () => {
    const mappings = [
      { timestamp: 1000, domain: "old-domain.com", ip: "1.2.3.4" },
      { timestamp: 3000, domain: "new-domain.com", ip: "1.2.3.4" },
      { timestamp: 2000, domain: "middle-domain.com", ip: "1.2.3.4" },
    ];

    const result = buildIpToDomainMap(mappings);

    expect(result.get("1.2.3.4")).toBe("new-domain.com");
  });

  test("handles multiple entries for same domain", () => {
    const mappings = [
      { timestamp: 1000, domain: "cdn.example.com", ip: "1.1.1.1" },
      { timestamp: 1000, domain: "cdn.example.com", ip: "2.2.2.2" },
    ];

    const result = buildIpToDomainMap(mappings);

    expect(result.get("1.1.1.1")).toBe("cdn.example.com");
    expect(result.get("2.2.2.2")).toBe("cdn.example.com");
  });

  test("returns empty map for empty input", () => {
    expect(buildIpToDomainMap([])).toEqual(new Map());
  });
});
