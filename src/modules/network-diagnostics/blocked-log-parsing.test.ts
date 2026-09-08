import { describe, expect, test } from "bun:test";
import {
  aggregateBlocked,
  type BlockedRequest,
  parseBlockedLog,
} from "./blocked-log-parsing.js";

describe("parseBlockedLog", () => {
  test("parses valid IPv4 tcpdump lines and converts to milliseconds", () => {
    const raw = `1769432985.426508 IP 192.168.215.2.52148 > 104.18.27.120.443: Flags [S], seq 123
1769432990.123456 IP 10.0.0.1.8080 > 8.8.8.8.53: Flags [S], seq 456`;

    const result = parseBlockedLog(raw);

    expect(result).toEqual([
      {
        timestamp: 1769432985426.508,
        srcIp: "192.168.215.2",
        srcPort: 52148,
        dstIp: "104.18.27.120",
        dstPort: 443,
      },
      {
        timestamp: 1769432990123.456,
        srcIp: "10.0.0.1",
        srcPort: 8080,
        dstIp: "8.8.8.8",
        dstPort: 53,
      },
    ]);
  });

  test("returns empty array for empty input", () => {
    expect(parseBlockedLog("")).toEqual([]);
  });

  test("returns empty array for whitespace-only input", () => {
    expect(parseBlockedLog("   \n\t\n  ")).toEqual([]);
  });

  test("skips malformed lines without throwing", () => {
    const raw = `1769432985.426508 IP 192.168.215.2.52148 > 104.18.27.120.443: Flags [S]
this is not valid
incomplete line 123
1769432990.123456 IP 10.0.0.1.8080 > 8.8.8.8.53: Flags [S]`;

    const result = parseBlockedLog(raw);

    expect(result).toHaveLength(2);
    expect(result[0]?.srcIp).toBe("192.168.215.2");
    expect(result[1]?.srcIp).toBe("10.0.0.1");
  });

  test("skips IPv6 lines gracefully", () => {
    const raw = `1769432985.426508 IP 192.168.215.2.52148 > 104.18.27.120.443: Flags [S]
1769432986.000000 IP6 2001:db8::1.52148 > 2001:db8::2.443: Flags [S]
1769432990.123456 IP 10.0.0.1.8080 > 8.8.8.8.53: Flags [S]`;

    const result = parseBlockedLog(raw);

    expect(result).toHaveLength(2);
    expect(result.every((r) => !r.srcIp.includes(":"))).toBe(true);
  });
});

describe("aggregateBlocked", () => {
  test("maps BlockedRequest fields to AggregatedBlocked format", () => {
    const requests: BlockedRequest[] = [
      {
        timestamp: 1000,
        srcIp: "192.168.1.1",
        srcPort: 12345,
        dstIp: "8.8.8.8",
        dstPort: 53,
      },
      {
        timestamp: 2000,
        srcIp: "192.168.1.2",
        srcPort: 12346,
        dstIp: "8.8.8.8",
        dstPort: 53,
      },
    ];

    const result = aggregateBlocked(requests);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      dstIp: "8.8.8.8",
      dstPort: 53,
      count: 2,
      lastSeen: 2000,
    });
  });

  test("sorts results by count descending", () => {
    const requests: BlockedRequest[] = [
      // 1 request to 1.1.1.1:443
      {
        timestamp: 1000,
        srcIp: "192.168.1.1",
        srcPort: 1,
        dstIp: "1.1.1.1",
        dstPort: 443,
      },
      // 3 requests to 8.8.8.8:53
      {
        timestamp: 1000,
        srcIp: "192.168.1.1",
        srcPort: 2,
        dstIp: "8.8.8.8",
        dstPort: 53,
      },
      {
        timestamp: 1000,
        srcIp: "192.168.1.1",
        srcPort: 3,
        dstIp: "8.8.8.8",
        dstPort: 53,
      },
      {
        timestamp: 1000,
        srcIp: "192.168.1.1",
        srcPort: 4,
        dstIp: "8.8.8.8",
        dstPort: 53,
      },
      // 2 requests to 10.0.0.1:80
      {
        timestamp: 1000,
        srcIp: "192.168.1.1",
        srcPort: 5,
        dstIp: "10.0.0.1",
        dstPort: 80,
      },
      {
        timestamp: 1000,
        srcIp: "192.168.1.1",
        srcPort: 6,
        dstIp: "10.0.0.1",
        dstPort: 80,
      },
    ];

    const result = aggregateBlocked(requests);

    expect(result).toHaveLength(3);
    expect(result[0]?.count).toBe(3);
    expect(result[0]?.dstIp).toBe("8.8.8.8");
    expect(result[1]?.count).toBe(2);
    expect(result[1]?.dstIp).toBe("10.0.0.1");
    expect(result[2]?.count).toBe(1);
    expect(result[2]?.dstIp).toBe("1.1.1.1");
  });

  test("returns empty array for empty input", () => {
    expect(aggregateBlocked([])).toEqual([]);
  });
});
