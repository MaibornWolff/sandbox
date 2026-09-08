import { describe, expect, test } from "bun:test";
import {
  aggregateProxyLog,
  type ProxyLogEntry,
  parseProxyLog,
} from "./proxy-log-parsing.js";

describe("parseProxyLog", () => {
  test("parses HTTPS CONNECT allowed request (TCP_TUNNEL)", () => {
    const raw =
      "1709136699.123     45 127.0.0.1 TCP_TUNNEL/200 5000 CONNECT registry.npmjs.org:443 - HIER_DIRECT/104.16.7.34 -";

    const result = parseProxyLog(raw);

    expect(result).toEqual([
      {
        domain: "registry.npmjs.org",
        port: 443,
        status: "allowed",
        timestamp: 1709136699123,
      },
    ]);
  });

  test("parses CONNECT denied request (TCP_DENIED)", () => {
    const raw =
      "1709136699.456      0 127.0.0.1 TCP_DENIED/403 3456 CONNECT evil.com:443 - HIER_NONE/- text/html";

    const result = parseProxyLog(raw);

    expect(result).toEqual([
      {
        domain: "evil.com",
        port: 443,
        status: "denied",
        timestamp: 1709136699456,
      },
    ]);
  });

  test("parses HTTP GET allowed request (TCP_MISS)", () => {
    const raw =
      "1709136699.789    200 127.0.0.1 TCP_MISS/200 12345 GET http://example.com/path - HIER_DIRECT/1.2.3.4 text/html";

    const result = parseProxyLog(raw);

    expect(result).toEqual([
      {
        domain: "example.com",
        port: 80,
        status: "allowed",
        timestamp: 1709136699789,
      },
    ]);
  });

  test("parses HTTP GET with custom port", () => {
    const raw =
      "1709136699.100    100 127.0.0.1 TCP_MISS/200 500 GET http://registry.example.com:8080/v2/ - HIER_DIRECT/1.2.3.4 text/html";

    const result = parseProxyLog(raw);

    expect(result).toEqual([
      {
        domain: "registry.example.com",
        port: 8080,
        status: "allowed",
        timestamp: 1709136699100,
      },
    ]);
  });

  test("parses SSH tunnel via CONNECT on port 22", () => {
    const raw =
      "1709136700.000     77 127.0.0.1 TCP_TUNNEL/200 3725 CONNECT github.com:22 - HIER_DIRECT/140.82.121.4 -";

    const result = parseProxyLog(raw);

    expect(result).toEqual([
      {
        domain: "github.com",
        port: 22,
        status: "allowed",
        timestamp: 1709136700000,
      },
    ]);
  });

  test("normalizes domain to lowercase", () => {
    const raw =
      "1709136699.123     45 127.0.0.1 TCP_TUNNEL/200 5000 CONNECT GITHUB.COM:443 - HIER_DIRECT/1.2.3.4 -";

    const result = parseProxyLog(raw);

    expect(result).toEqual([
      {
        domain: "github.com",
        port: 443,
        status: "allowed",
        timestamp: 1709136699123,
      },
    ]);
  });
});

describe("parseProxyLog - advanced", () => {
  test("parses mixed allowed and denied requests", () => {
    const raw = [
      "1709136699.100     45 127.0.0.1 TCP_TUNNEL/200 5000 CONNECT github.com:443 - HIER_DIRECT/140.82.121.4 -",
      "1709136699.200      0 127.0.0.1 TCP_DENIED/403 3456 CONNECT evil.com:443 - HIER_NONE/- text/html",
      "1709136699.300     30 127.0.0.1 TCP_TUNNEL/200 4000 CONNECT api.github.com:443 - HIER_DIRECT/140.82.121.5 -",
    ].join("\n");

    const result = parseProxyLog(raw);

    expect(result).toEqual([
      {
        domain: "github.com",
        port: 443,
        status: "allowed",
        timestamp: 1709136699100,
      },
      {
        domain: "evil.com",
        port: 443,
        status: "denied",
        timestamp: 1709136699200,
      },
      {
        domain: "api.github.com",
        port: 443,
        status: "allowed",
        timestamp: 1709136699300,
      },
    ]);
  });

  test("returns empty array for empty input", () => {
    expect(parseProxyLog("")).toEqual([]);
    expect(parseProxyLog("\n\n")).toEqual([]);
  });

  test("skips malformed or non-access-log lines", () => {
    const raw = [
      "some random startup message",
      "WARNING: something went wrong",
      "",
      "1709136699.100     45 127.0.0.1 TCP_TUNNEL/200 5000 CONNECT github.com:443 - HIER_DIRECT/1.2.3.4 -",
    ].join("\n");

    const result = parseProxyLog(raw);

    expect(result).toEqual([
      {
        domain: "github.com",
        port: 443,
        status: "allowed",
        timestamp: 1709136699100,
      },
    ]);
  });

  test("parses HTTP GET denied request", () => {
    const raw =
      "1709136699.100      0 127.0.0.1 TCP_DENIED/403 3456 GET http://blocked.com/ - HIER_NONE/- text/html";

    const result = parseProxyLog(raw);

    expect(result).toEqual([
      {
        domain: "blocked.com",
        port: 80,
        status: "denied",
        timestamp: 1709136699100,
      },
    ]);
  });
});

describe("aggregateProxyLog", () => {
  const baseTs = 1709136699000;

  test("aggregates duplicate entries by domain+port+status", () => {
    const entries: ProxyLogEntry[] = [
      { domain: "github.com", port: 443, status: "allowed", timestamp: baseTs },
      {
        domain: "github.com",
        port: 443,
        status: "allowed",
        timestamp: baseTs + 1000,
      },
      { domain: "evil.com", port: 443, status: "denied", timestamp: baseTs },
      {
        domain: "github.com",
        port: 443,
        status: "allowed",
        timestamp: baseTs + 2000,
      },
      {
        domain: "evil.com",
        port: 443,
        status: "denied",
        timestamp: baseTs + 1000,
      },
    ];

    const result = aggregateProxyLog(entries);

    expect(result).toHaveLength(2);
    expect(result.find((e) => e.domain === "github.com")).toEqual({
      domain: "github.com",
      port: 443,
      status: "allowed",
      count: 3,
      lastSeen: baseTs + 2000,
    });
    expect(result.find((e) => e.domain === "evil.com")).toEqual({
      domain: "evil.com",
      port: 443,
      status: "denied",
      count: 2,
      lastSeen: baseTs + 1000,
    });
  });

  test("keeps different ports separate", () => {
    const entries: ProxyLogEntry[] = [
      { domain: "github.com", port: 443, status: "allowed", timestamp: baseTs },
      { domain: "github.com", port: 22, status: "allowed", timestamp: baseTs },
    ];

    const result = aggregateProxyLog(entries);

    expect(result).toHaveLength(2);
  });

  test("returns empty array for empty input", () => {
    expect(aggregateProxyLog([])).toEqual([]);
  });
});
