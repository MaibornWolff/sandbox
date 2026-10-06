import { describe, expect, test } from "bun:test";
import { parseNetworkBootstrapRequest } from "./bootstrap-request-parsing.js";
import { renderDnsmasqConfig } from "./dnsmasq-config-rendering.js";
import { buildFirewallPlan, buildIpv6FirewallPlan } from "./firewall-plan.js";
import { parseGuestHostMappings } from "./guest-host-mappings.js";
import { renderSquidConfig } from "./squid-config-rendering.js";

const restrictedRequest = {
  enabled: true,
  allowNetwork: [
    { host: "github.com", ports: [22, 443], wildcard: false },
    { host: "example.com", ports: [8080], wildcard: true },
  ],
  fullNetwork: false,
  noProxy: false,
};

const allPortRequest = {
  ...restrictedRequest,
  allowNetwork: [
    { host: "all.example", ports: "*" as const, wildcard: false },
    { host: "restricted.example", ports: [443], wildcard: false },
  ],
};

describe("guest host mappings", () => {
  test("accepts exact aliases and rejects invalid or conflicting input", () => {
    expect(
      parseGuestHostMappings(
        JSON.stringify([
          { host: "host.container.internal", address: "192.168.64.1" },
          { host: "host.docker.internal", address: "192.168.64.1" },
        ]),
      ),
    ).toHaveLength(2);
    expect(() =>
      parseGuestHostMappings(
        JSON.stringify([{ host: "*.internal", address: "192.168.64.1" }]),
      ),
    ).toThrow("invalid host");
    expect(() =>
      parseGuestHostMappings(
        JSON.stringify([
          { host: "host.internal", address: "192.168.64.1" },
          { host: "host.internal", address: "192.168.64.2" },
        ]),
      ),
    ).toThrow("conflicting addresses");
  });
});

describe("network bootstrap request", () => {
  test("normalizes a valid JSON request", () => {
    expect(
      parseNetworkBootstrapRequest(JSON.stringify(restrictedRequest)),
    ).toEqual(restrictedRequest);
  });

  test("preserves a serialized all-port selection", () => {
    expect(
      parseNetworkBootstrapRequest(JSON.stringify(allPortRequest)),
    ).toEqual(allPortRequest);
  });

  for (const value of [
    undefined,
    "not-json",
    "null",
    "{}",
    JSON.stringify({ ...restrictedRequest, enabled: "true" }),
    JSON.stringify({
      ...restrictedRequest,
      allowNetwork: [{ host: "", ports: [443], wildcard: false }],
    }),
    JSON.stringify({
      ...restrictedRequest,
      allowNetwork: [{ host: "x", ports: "all", wildcard: false }],
    }),
    JSON.stringify({
      ...restrictedRequest,
      allowNetwork: [{ host: "x", ports: [443, "*"], wildcard: false }],
    }),
    JSON.stringify({
      ...restrictedRequest,
      allowNetwork: [{ host: "x", ports: [0], wildcard: false }],
    }),
    JSON.stringify({
      ...restrictedRequest,
      allowNetwork: [{ host: "x", ports: [443.5], wildcard: false }],
    }),
    JSON.stringify({
      ...restrictedRequest,
      allowNetwork: [{ host: "x", wildcard: false }],
    }),
  ]) {
    test(`rejects malformed input ${String(value)}`, () => {
      expect(() => parseNetworkBootstrapRequest(value)).toThrow(
        "Invalid network bootstrap request",
      );
    });
  }
});

describe("firewall planning", () => {
  test("returns no commands when disabled", () => {
    expect(buildFirewallPlan({ ...restrictedRequest, enabled: false })).toEqual(
      [],
    );
  });

  test("preserves restricted rule ordering and unique custom ports", () => {
    const plan = buildFirewallPlan(restrictedRequest);
    expect(plan.slice(0, 3)).toEqual([
      ["-F", "OUTPUT"],
      ["-A", "OUTPUT", "-o", "lo", "-j", "ACCEPT"],
      [
        "-A",
        "OUTPUT",
        "-m",
        "state",
        "--state",
        "ESTABLISHED,RELATED",
        "-j",
        "ACCEPT",
      ],
    ]);
    expect(plan).toContainEqual([
      "-A",
      "OUTPUT",
      "-p",
      "tcp",
      "--dport",
      "22",
      "-m",
      "owner",
      "--uid-owner",
      "proxy",
      "-j",
      "ACCEPT",
    ]);
    expect(
      plan
        .filter((command) => command.includes("proxy"))
        .map((command) => command[command.indexOf("--dport") + 1]),
    ).toEqual(["22", "443", "8080"]);
    for (const privateRange of [
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
    ]) {
      expect(plan.flat()).not.toContain(privateRange);
    }
    expect(plan.at(-2)).toEqual([
      "-A",
      "OUTPUT",
      "-j",
      "NFLOG",
      "--nflog-group",
      "100",
      "-m",
      "limit",
      "--limit",
      "10/min",
      "--limit-burst",
      "20",
    ]);
    expect(plan.at(-1)).toEqual([
      "-A",
      "OUTPUT",
      "-j",
      "REJECT",
      "--reject-with",
      "icmp-port-unreachable",
    ]);
  });

  test("allows all proxy ports when one host selects all ports", () => {
    const plan = buildFirewallPlan(allPortRequest);
    expect(plan).toContainEqual([
      "-A",
      "OUTPUT",
      "-m",
      "owner",
      "--uid-owner",
      "proxy",
      "-j",
      "ACCEPT",
    ]);
    expect(plan.some((command) => command.includes("--dport"))).toBe(true);
    expect(
      plan.some(
        (command) => command.includes("--dport") && command.includes("proxy"),
      ),
    ).toBe(false);
  });

  test("allows all proxy ports in full-network mode", () => {
    expect(
      buildFirewallPlan({ ...restrictedRequest, fullNetwork: true }),
    ).toContainEqual([
      "-A",
      "OUTPUT",
      "-m",
      "owner",
      "--uid-owner",
      "proxy",
      "-j",
      "ACCEPT",
    ]);
  });

  test("allows direct sandbox traffic and omits proxy users in no-proxy mode", () => {
    const plan = buildFirewallPlan({ ...restrictedRequest, noProxy: true });
    expect(plan).toContainEqual([
      "-A",
      "OUTPUT",
      "-m",
      "owner",
      "--uid-owner",
      "sandbox",
      "-j",
      "ACCEPT",
    ]);
    expect(plan.flat()).not.toContain("dnsmasq");
    expect(plan.flat()).not.toContain("proxy");
  });

  test("supports an empty allowlist", () => {
    expect(
      buildFirewallPlan({ ...restrictedRequest, allowNetwork: [] }),
    ).toHaveLength(7);
  });
});

describe("IPv6 firewall policy", () => {
  test("allows only scoped proxy DNS and required address configuration", () => {
    const plan = buildIpv6FirewallPlan(restrictedRequest, "fe80::1234%ens4");
    expect(plan).toContainEqual([
      "-A",
      "OUTPUT",
      "-p",
      "udp",
      "-d",
      "fe80::1234",
      "-o",
      "ens4",
      "--dport",
      "53",
      "-m",
      "owner",
      "--uid-owner",
      "dnsmasq",
      "-j",
      "ACCEPT",
    ]);
    expect(plan).toContainEqual([
      "-A",
      "OUTPUT",
      "-p",
      "tcp",
      "-d",
      "fe80::1234",
      "-o",
      "ens4",
      "--dport",
      "53",
      "-m",
      "owner",
      "--uid-owner",
      "dnsmasq",
      "-j",
      "ACCEPT",
    ]);
    expect(
      plan.filter((command) => command.includes("ipv6-icmp")),
    ).toHaveLength(4);
    expect(plan.at(-1)).toContain("REJECT");
    expect(plan.flat()).not.toContain("proxy");
  });

  test("blocks direct IPv6 in proxy mode without an IPv6 upstream", () => {
    const plan = buildIpv6FirewallPlan(restrictedRequest, "192.168.64.1");
    expect(plan.flat()).not.toContain("dnsmasq");
    expect(plan.flat()).not.toContain("sandbox");
    expect(plan.at(-1)).toContain("REJECT");
  });
});

describe("network configuration rendering", () => {
  test("renders restricted DNS with internal exceptions and tracing", () => {
    const config = renderDnsmasqConfig(
      restrictedRequest,
      "1.1.1.1",
      [{ host: "host.docker.internal", address: "192.168.64.1" }],
      "host.docker.internal",
    );
    expect(config).toContain("log-queries");
    expect(config).toContain("no-negcache");
    expect(config).not.toContain("neg-ttl");
    expect(config).toContain("address=/#/");
    expect(config).toContain("host-record=host.docker.internal,192.168.64.1");
    expect(config).toContain("server=/github.com/1.1.1.1");
    expect(config).toMatchSnapshot();
  });

  test.each([
    "host.docker.internal",
    "host.containers.internal",
    "host.container.internal",
  ])("maps %s without adding a firewall exception", (hostAccessName) => {
    expect(
      renderDnsmasqConfig(
        restrictedRequest,
        "1.1.1.1",
        [{ host: hostAccessName, address: "192.168.64.1" }],
        hostAccessName,
      ),
    ).toContain(`host-record=${hostAccessName},192.168.64.1`);
    expect(buildFirewallPlan(restrictedRequest).flat()).not.toContain(
      hostAccessName,
    );
  });

  test("renders allow-all DNS", () => {
    const config = renderDnsmasqConfig(
      { ...restrictedRequest, fullNetwork: true },
      "1.1.1.1",
      [{ host: "host.docker.internal", address: "192.168.64.1" }],
      "host.docker.internal",
    );
    expect(config).toContain("server=/#/1.1.1.1");
    expect(config).not.toContain("address=/#/");
    expect(config).toMatchSnapshot();
  });

  test("rejects a missing upstream resolver", () => {
    expect(() =>
      renderDnsmasqConfig(restrictedRequest, "", [], "host.docker.internal"),
    ).toThrow("No upstream DNS server found");
  });

  test("binds each Squid domain group to its own port ACL for every method", () => {
    const rendered = renderSquidConfig(allPortRequest);
    expect(rendered.domainAclGroups).toEqual([
      { id: 0, content: "all.example\n" },
      { id: 1, content: "restricted.example\n" },
    ]);
    expect(rendered.config).toContain("acl allowed_ports_0 port 1-65535");
    expect(rendered.config).toContain("acl allowed_ports_1 port 443");
    expect(rendered.config).toContain(
      "http_access allow allowed_domains_0 allowed_ports_0",
    );
    expect(rendered.config).toContain(
      "http_access allow allowed_domains_1 allowed_ports_1",
    );
    expect(rendered.config).not.toContain("!CONNECT");
    expect(rendered.config).not.toContain("allow CONNECT");
    expect(rendered.config).toContain("negative_dns_ttl 0 seconds");
    expect(rendered.config).not.toContain("dns_v4_first");
    expect(rendered.config).toContain("deny_info ERR_SANDBOX_BLOCKED all");
    expect(rendered.blockedErrorPage).toContain("HTTP 403 Blocked");
    expect(rendered.config).toMatchSnapshot();
  });

  test("removes exact domains covered by a wildcard in the same port group", () => {
    const rendered = renderSquidConfig({
      ...restrictedRequest,
      allowNetwork: [
        { host: "github.com", ports: [80, 443], wildcard: true },
        { host: "api.github.com", ports: [80, 443], wildcard: false },
        { host: "codeload.github.com", ports: [80, 443], wildcard: false },
        { host: "github.com", ports: [22, 80, 443], wildcard: false },
      ],
    });

    expect(rendered.domainAclGroups).toEqual([
      { id: 0, content: "github.com\n" },
      { id: 1, content: ".github.com\n" },
    ]);
  });

  test("preserves effective port unions across exact and wildcard rules", () => {
    const rendered = renderSquidConfig({
      ...restrictedRequest,
      allowNetwork: [
        { host: "github.com", ports: [80, 443], wildcard: false },
        { host: "github.com", ports: [123], wildcard: false },
        { host: "api.github.com", ports: [80, 443], wildcard: false },
        { host: "github.com", ports: [22], wildcard: true },
      ],
    });

    expect(rendered.domainAclGroups).toEqual([
      { id: 0, content: "github.com\n" },
      { id: 1, content: ".github.com\n" },
      { id: 2, content: "github.com\napi.github.com\n" },
    ]);
    expect(rendered.config).toContain("acl allowed_ports_0 port 123");
    expect(rendered.config).toContain("acl allowed_ports_1 port 22");
    expect(rendered.config).toContain("acl allowed_ports_2 port 80 443");
  });

  test.each([
    {
      name: "nested exact domains in the same port group",
      allowNetwork: [
        { host: "github.com", ports: [443], wildcard: true },
        { host: "api.github.com", ports: [443], wildcard: false },
        { host: "v1.api.github.com", ports: [443], wildcard: false },
      ],
      expectedContent: ".github.com\n",
    },
    {
      name: "a sibling domain",
      allowNetwork: [
        { host: "github.com", ports: [443], wildcard: true },
        { host: "notgithub.com", ports: [443], wildcard: false },
      ],
      expectedContent: ".github.com\nnotgithub.com\n",
    },
    {
      name: "an exact domain in a different port group",
      allowNetwork: [
        { host: "github.com", ports: [22], wildcard: true },
        { host: "api.github.com", ports: [443], wildcard: false },
      ],
      expectedContent: ".github.com\n|api.github.com\n",
    },
  ])(
    "preserves Squid wildcard policy for $name",
    ({ allowNetwork, expectedContent }) => {
      const rendered = renderSquidConfig({
        ...restrictedRequest,
        allowNetwork: allowNetwork.map((rule) => ({
          ...rule,
          ports: [...rule.ports],
        })),
      });

      expect(
        rendered.domainAclGroups?.map(({ content }) => content).join("|"),
      ).toBe(expectedContent);
    },
  );

  test("renders allow-all Squid without ACL files", () => {
    const rendered = renderSquidConfig({
      ...restrictedRequest,
      fullNetwork: true,
    });
    expect(rendered.domainAclGroups).toBeUndefined();
    expect(rendered.config).toContain("http_access allow all");
    expect(rendered).toMatchSnapshot();
  });
});
