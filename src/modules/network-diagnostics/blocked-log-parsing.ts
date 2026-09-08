import { aggregateLogEntries } from "./log-entry-aggregation.js";

/** @testonly */
export interface BlockedRequest {
  timestamp: number;
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
}

interface AggregatedBlocked {
  dstIp: string;
  dstPort: number;
  count: number;
  lastSeen: number;
}

/**
 * Regex for parsing tcpdump IPv4 output format.
 * Note: IPv6 lines (e.g., "IP6 ...") are intentionally not matched and will be skipped.
 */
const TCPDUMP_IPV4_REGEX =
  /^(\d+\.\d+)\s+IP\s+([\d.]+)\.(\d+)\s+>\s+([\d.]+)\.(\d+):/;

export function parseBlockedLog(raw: string): BlockedRequest[] {
  const results: BlockedRequest[] = [];
  const lines = raw.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(TCPDUMP_IPV4_REGEX);
    if (!match) continue;

    const timestampStr = match[1];
    const srcIp = match[2];
    const srcPortStr = match[3];
    const dstIp = match[4];
    const dstPortStr = match[5];

    if (!timestampStr || !srcIp || !srcPortStr || !dstIp || !dstPortStr) {
      continue;
    }

    results.push({
      // Convert Unix seconds to milliseconds for consistency with Date.now()
      timestamp: parseFloat(timestampStr) * 1000,
      srcIp,
      srcPort: parseInt(srcPortStr, 10),
      dstIp,
      dstPort: parseInt(dstPortStr, 10),
    });
  }

  return results;
}

export function aggregateBlocked(
  requests: BlockedRequest[],
): AggregatedBlocked[] {
  const items = requests.map((r) => ({
    dstIp: r.dstIp,
    dstPort: r.dstPort,
    count: 1,
    lastSeen: r.timestamp,
  }));
  return aggregateLogEntries(items, (i) => `${i.dstIp}:${i.dstPort}`).sort(
    (a, b) => b.count - a.count,
  );
}
