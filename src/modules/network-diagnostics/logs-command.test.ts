import { describe, expect, test } from "bun:test";
import type { NetworkLogEntry } from "./network-diagnostics.js";
import {
  buildRawDiagnosticSections,
  prepareNetworkLogEntries,
} from "./network-log-presentation.js";

function entry(overrides: Partial<NetworkLogEntry>): NetworkLogEntry {
  return {
    container: "container-1",
    image: "sandbox-project:latest",
    destination: "example.com",
    dstIp: "1.2.3.4",
    port: 443,
    count: 1,
    lastSeen: 100,
    status: "BLOCKED",
    ...overrides,
  };
}

describe("network log presentation", () => {
  test("aggregates, filters, and sorts observations", () => {
    const result = prepareNetworkLogEntries(
      [
        entry({ destination: "older.example", lastSeen: 10 }),
        entry({ destination: "same.example", count: 2, lastSeen: 20 }),
        entry({ destination: "same.example", count: 3, lastSeen: 30 }),
        entry({ destination: "allowed.example", status: "ALLOWED" }),
      ],
      { showAllowed: false },
    );
    expect(
      result.map(({ destination, count }) => ({ destination, count })),
    ).toEqual([
      { destination: "same.example", count: 5 },
      { destination: "older.example", count: 1 },
    ]);
  });

  test("keeps allowed observations when requested", () => {
    expect(
      prepareNetworkLogEntries([entry({ status: "ALLOWED" })], {
        showAllowed: true,
      }),
    ).toHaveLength(1);
  });

  test("builds the stable raw diagnostic section order", () => {
    const diagnostic = { output: "value" };
    expect(
      buildRawDiagnosticSections({
        runtimeLog: diagnostic,
        networkState: diagnostic,
        firewall: diagnostic,
        dns: diagnostic,
        proxyAccess: diagnostic,
        proxyCache: diagnostic,
      }).map(({ title }) => title),
    ).toEqual([
      "CONTAINER LOG (last 200 lines)",
      "NETWORK STATE",
      "FIREWALL LOG (iptables/NFLOG)",
      "DNS LOG (dnsmasq)",
      "PROXY ACCESS LOG (Squid)",
      "PROXY CACHE LOG (Squid)",
    ]);
  });
});
