/**
 * DNS-blocked entry from dnsmasq log.
 * Blocked queries show as "config" lines (from address=/#/ or similar directives).
 */
interface DnsBlockedEntry {
  domain: string;
  count: number;
  /** Most recent timestamp in ms since epoch */
  lastSeen: number;
}

import { isIpAddress } from "#platform/container-system/index.js";
import { aggregateLogEntries } from "./log-entry-aggregation.js";
import { extractLogTimestamp } from "./log-timestamp-parsing.js";

// Matches dnsmasq timestamp: "Feb 16 14:11:39" from log lines
// Format: Feb 16 14:11:39 dnsmasq[123]: ...
const DNS_TIMESTAMP_RE = /^(\w+ \d+ \d+:\d+:\d+)/;

interface DnsReply {
  domain: string;
  value: string;
  timestamp: number;
}

function parseDnsReplies(raw: string, referenceTime: number): DnsReply[] {
  const replies: DnsReply[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.includes("reply")) continue;
    const match = trimmed.match(/reply\s+(\S+)\s+is\s+(\S+)/);
    if (!match?.[1] || !match[2]) continue;
    replies.push({
      domain: match[1].toLowerCase(),
      value: match[2],
      timestamp: extractLogTimestamp(trimmed, DNS_TIMESTAMP_RE, referenceTime),
    });
  }
  return replies;
}

/**
 * Parse dnsmasq log for blocked DNS queries.
 * Any "config <domain> is <response>" line indicates a locally-configured answer,
 * which in our setup means the domain was blocked. This covers:
 * - `address=/#/` → logs "config evil.com is NXDOMAIN"
 * - `address=/#/0.0.0.0` → logs "config evil.com is 0.0.0.0"
 * - IPv6 blocks → logs "config evil.com is ::"
 * Aggregates by domain, counts occurrences, tracks most recent timestamp.
 */
export function parseDnsBlockedDomains(
  raw: string,
  referenceTime: number,
): DnsBlockedEntry[] {
  const lines = raw.split("\n");
  const items: DnsBlockedEntry[] = [];

  for (const line of lines) {
    if (!line) continue;
    const trimmed = line.trim();
    if (!trimmed.includes("config")) continue;

    // Match any "config <domain> is <response>" line from dnsmasq
    const match = trimmed.match(/config\s+(\S+)\s+is\s+\S+/);
    if (!match?.[1]) continue;

    const domain = match[1].toLowerCase();
    const timestamp = extractLogTimestamp(
      trimmed,
      DNS_TIMESTAMP_RE,
      referenceTime,
    );

    items.push({ domain, count: 1, lastSeen: timestamp });
  }

  return aggregateLogEntries(items, (i) => i.domain);
}

/**
 * DNS-allowed entry from dnsmasq log.
 * In full-network mode, allowed queries show as "reply" lines with an IP address.
 */
interface DnsAllowedEntry {
  domain: string;
  count: number;
  /** Most recent timestamp in ms since epoch */
  lastSeen: number;
}

/**
 * Parse dnsmasq log for successfully resolved DNS queries.
 * Parses "reply <domain> is <ip>" lines. CNAME replies (where the value is
 * a domain name rather than an IP) are skipped to avoid double-counting by
 * requiring strict IPv4/IPv6 validation for the reply value.
 * Aggregates by domain, counts occurrences, tracks most recent timestamp.
 */
export function parseDnsAllowedDomains(
  raw: string,
  referenceTime: number,
): DnsAllowedEntry[] {
  const items = parseDnsReplies(raw, referenceTime)
    .filter(({ value }) => isIpAddress(value))
    .map(({ domain, timestamp }) => ({
      domain,
      count: 1,
      lastSeen: timestamp,
    }));
  return aggregateLogEntries(items, (item) => item.domain);
}

/**
 * DNS mapping from dnsmasq log output
 * Format: Jan 15 10:30:00 dnsmasq[123]: reply github.com is 140.82.121.4
 */
interface DnsMapping {
  /** Timestamp in ms since epoch, parsed from syslog timestamp */
  timestamp: number;
  domain: string;
  ip: string;
}

/**
 * Parse dnsmasq log output into mappings
 * Each reply line: "Jan 15 10:30:00 dnsmasq[123]: reply github.com is 140.82.121.4"
 */
export function parseDnsLog(raw: string, referenceTime: number): DnsMapping[] {
  return parseDnsReplies(raw, referenceTime).map(
    ({ domain, value, timestamp }) => ({
      timestamp,
      domain,
      ip: value,
    }),
  );
}

/**
 * Build IP → domain mapping from DNS log
 * Uses most recent domain for each IP
 */
export function buildIpToDomainMap(
  mappings: DnsMapping[],
): Map<string, string> {
  const ipToDomain = new Map<string, { domain: string; timestamp: number }>();

  for (const mapping of mappings) {
    const existing = ipToDomain.get(mapping.ip);
    // Keep the most recent mapping for each IP
    if (!existing || mapping.timestamp >= existing.timestamp) {
      ipToDomain.set(mapping.ip, {
        domain: mapping.domain,
        timestamp: mapping.timestamp,
      });
    }
  }

  // Return just domain names
  const result = new Map<string, string>();
  for (const [ip, { domain }] of ipToDomain) {
    result.set(ip, domain);
  }
  return result;
}
