/**
 * Parsed proxy log entry from squid access log.
 *
 * Squid logs requests in its native format:
 *   1709136699.123     45 127.0.0.1 TCP_TUNNEL/200 5000 CONNECT registry.npmjs.org:443 - HIER_DIRECT/1.2.3.4 -
 *   1709136699.456      0 127.0.0.1 TCP_DENIED/403 3456 CONNECT evil.com:443 - HIER_NONE/- text/html
 *   1709136699.789    200 127.0.0.1 TCP_MISS/200 12345 GET http://example.com/path - HIER_DIRECT/1.2.3.4 text/html
 * @testonly
 */
export interface ProxyLogEntry {
  domain: string;
  port: number;
  status: "allowed" | "denied";
  /** Timestamp in ms since epoch, parsed from squid log line */
  timestamp: number;
}

/**
 * Squid native log format fields (space-separated):
 *   0: timestamp (unix epoch with ms, e.g., 1709136699.123)
 *   1: elapsed time in ms
 *   2: client IP
 *   3: squid status/HTTP status (e.g., TCP_TUNNEL/200, TCP_DENIED/403)
 *   4: bytes
 *   5: method (CONNECT, GET, etc.)
 *   6: URL (for CONNECT: host:port, for HTTP: http://domain/path)
 *   7: ident (usually -)
 *   8: hierarchy/peer (e.g., HIER_DIRECT/1.2.3.4)
 *   9: content type
 */

/** Extract domain and port from a CONNECT URL (host:port) or HTTP URL. */
function parseDomainPort(
  method: string,
  url: string,
): { domain: string; port: number } | null {
  if (method === "CONNECT") {
    const colonIdx = url.lastIndexOf(":");
    if (colonIdx === -1) return null;
    const port = Number.parseInt(url.substring(colonIdx + 1), 10);
    if (Number.isNaN(port)) return null;
    return { domain: url.substring(0, colonIdx).toLowerCase(), port };
  }
  const match = url.match(/^(https?):\/\/([^/:]+)(?::(\d+))?/);
  if (!match?.[2]) return null;
  const defaultPort = match[1] === "https" ? 443 : 80;
  return {
    domain: match[2].toLowerCase(),
    port: match[3] ? Number.parseInt(match[3], 10) : defaultPort,
  };
}

/** Parse a single squid access log line into a proxy log entry. */
function parseSquidLine(line: string): {
  domain: string;
  port: number;
  status: "allowed" | "denied";
  timestamp: number;
} | null {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 7) return null;

  const [timestampStr, , , statusField, , method, url] = fields;
  if (!timestampStr || !statusField || !method || !url) return null;

  const timestampSec = Number.parseFloat(timestampStr);
  if (Number.isNaN(timestampSec)) return null;

  const squidStatus = statusField.split("/")[0] ?? "";
  const domainPort = parseDomainPort(method, url);
  if (!domainPort) return null;

  return {
    ...domainPort,
    status: squidStatus === "TCP_DENIED" ? "denied" : "allowed",
    timestamp: Math.round(timestampSec * 1000),
  };
}

/**
 * Parse squid access log into proxy log entries.
 *
 * Each line in squid's native format produces one entry.
 * Lines that can't be parsed (startup messages, empty lines) are skipped.
 */
export function parseProxyLog(raw: string): ProxyLogEntry[] {
  const lines = raw.split("\n");
  const results: ProxyLogEntry[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const entry = parseSquidLine(line);
    if (entry) {
      results.push(entry);
    }
  }

  return results;
}

/**
 * Aggregate proxy log entries by domain+port+status, counting occurrences.
 */
interface AggregatedProxyEntry {
  domain: string;
  port: number;
  status: "allowed" | "denied";
  count: number;
  /** Most recent timestamp in ms since epoch */
  lastSeen: number;
}

import { aggregateLogEntries } from "./log-entry-aggregation.js";

export function aggregateProxyLog(
  entries: ProxyLogEntry[],
): AggregatedProxyEntry[] {
  const items = entries.map((e) => ({
    domain: e.domain,
    port: e.port,
    status: e.status,
    count: 1,
    lastSeen: e.timestamp,
  }));
  return aggregateLogEntries(items, (e) => `${e.domain}:${e.port}:${e.status}`);
}
