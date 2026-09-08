import { describe, expect, test } from "bun:test";
import type { AllowedNetwork } from "#modules/configuration/index.js";
import { deriveAllowDomainChoices } from "./allow-domain-selection.js";
import type { NetworkLogEntry } from "./network-diagnostics.js";

function entry(
  destination: string,
  port: number,
  status: "ALLOWED" | "BLOCKED" = "BLOCKED",
): NetworkLogEntry {
  return {
    container: "container-1",
    image: "sandbox-project:latest",
    destination,
    dstIp: "",
    port,
    count: 1,
    lastSeen: 1,
    status,
  };
}

describe("allow domain selection", () => {
  test("sorts blocked domains and excludes raw IPs and allowed observations", () => {
    expect(
      deriveAllowDomainChoices(
        [
          entry("zzz.example", 443),
          entry("zzz.example", 80),
          entry("8.8.8.8", 443),
          entry("allowed.example", 443, "ALLOWED"),
          entry("aaa.example", 443),
          entry("aaa.example", 80),
        ],
        [],
      ),
    ).toEqual([
      { name: "aaa.example", value: "aaa.example", checked: false },
      { name: "zzz.example", value: "zzz.example", checked: false },
    ]);
  });

  test("keeps a covered port 22 visible but disabled until the sandbox restarts", () => {
    expect(
      deriveAllowDomainChoices(
        [entry("gitlab.example", 22)],
        [{ host: "gitlab.example", ports: [22], wildcard: false }],
      ),
    ).toEqual([
      {
        name: "gitlab.example:22",
        value: "gitlab.example:22",
        checked: false,
        disabled: "Configured. Restart sandbox.",
      },
    ]);
  });

  test("keeps covered groups disabled while formatting uncovered ports for selection", () => {
    const allowed: AllowedNetwork[] = [
      { host: "api.example", ports: [443], wildcard: false },
    ];

    expect(
      deriveAllowDomainChoices(
        [entry("api.example", 443), entry("api.example", 22)],
        allowed,
      ),
    ).toEqual([
      {
        name: "api.example:22",
        value: "api.example:22",
        checked: false,
      },
      {
        name: "api.example:443",
        value: "api.example:443",
        checked: false,
        disabled: "Configured. Restart sandbox.",
      },
    ]);
  });

  for (const allowed of [
    [{ host: "api.example", ports: "*", wildcard: false }],
    [{ host: "example", ports: "*", wildcard: true }],
  ] satisfies AllowedNetwork[][]) {
    test(`marks every observed port configured for a matching ${allowed[0]?.wildcard ? "wildcard" : "exact"} all-port rule`, () => {
      expect(
        deriveAllowDomainChoices(
          [entry("api.example", 22), entry("api.example", 8443)],
          allowed,
        ),
      ).toEqual([
        {
          name: "api.example:{22,8443}",
          value: "api.example:{22,8443}",
          checked: false,
          disabled: "Configured. Restart sandbox.",
        },
      ]);
    });
  }

  test("aggregates blocked observations from multiple containers", () => {
    const first = entry("first.example", 443);
    const second = {
      ...entry("second.example", 443),
      container: "container-2",
    };

    expect(deriveAllowDomainChoices([first, second], [])).toEqual([
      {
        name: "first.example:443",
        value: "first.example:443",
        checked: false,
      },
      {
        name: "second.example:443",
        value: "second.example:443",
        checked: false,
      },
    ]);
  });

  test("uses default ports for DNS-only observations", () => {
    expect(deriveAllowDomainChoices([entry("dns.example", 0)], [])).toEqual([
      { name: "dns.example", value: "dns.example", checked: false },
    ]);
  });

  test("returns disabled choices when every blocked port is covered", () => {
    expect(
      deriveAllowDomainChoices(
        [entry("api.example", 443)],
        [{ host: "api.example", ports: [443], wildcard: false }],
      ),
    ).toEqual([
      {
        name: "api.example:443",
        value: "api.example:443",
        checked: false,
        disabled: "Configured. Restart sandbox.",
      },
    ]);
  });
});
