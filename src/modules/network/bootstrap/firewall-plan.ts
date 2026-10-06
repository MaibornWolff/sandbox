import {
  allowsAllNetworkPorts,
  getExplicitNetworkPorts,
} from "#modules/configuration/index.js";
import type { NetworkBootstrapRequest } from "./bootstrap-request-parsing.js";

/** @testonly */
export type FirewallCommandPlan = readonly (readonly string[])[];

const IPV6_CONFIGURATION_RULES: FirewallCommandPlan = [
  ["-F", "OUTPUT"],
  ["-A", "OUTPUT", "-o", "lo", "-j", "ACCEPT"],
  [
    "-A",
    "OUTPUT",
    "-m",
    "conntrack",
    "--ctstate",
    "ESTABLISHED,RELATED",
    "-j",
    "ACCEPT",
  ],
  ...[133, 134, 135, 136].map((type) => [
    "-A",
    "OUTPUT",
    "-p",
    "ipv6-icmp",
    "--icmpv6-type",
    String(type),
    "-j",
    "ACCEPT",
  ]),
];

const BASE_FIREWALL_RULES: FirewallCommandPlan = [
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
];

function ownerRule(owner: string): readonly string[] {
  return ["-A", "OUTPUT", "-m", "owner", "--uid-owner", owner, "-j", "ACCEPT"];
}

/** @testonly */
export function buildFirewallPlan(
  request: NetworkBootstrapRequest,
): FirewallCommandPlan {
  if (!request.enabled) return [];
  const commands: Array<readonly string[]> = [...BASE_FIREWALL_RULES];
  if (request.noProxy) {
    commands.push(ownerRule("sandbox"));
  } else {
    commands.push(
      [
        "-A",
        "OUTPUT",
        "-p",
        "udp",
        "--dport",
        "53",
        "-m",
        "owner",
        "--uid-owner",
        "dnsmasq",
        "-j",
        "ACCEPT",
      ],
      [
        "-A",
        "OUTPUT",
        "-p",
        "tcp",
        "--dport",
        "53",
        "-m",
        "owner",
        "--uid-owner",
        "dnsmasq",
        "-j",
        "ACCEPT",
      ],
    );
    const allowsAllProxyPorts = request.allowNetwork.some(({ ports }) =>
      allowsAllNetworkPorts(ports),
    );
    if (request.fullNetwork || allowsAllProxyPorts) {
      commands.push(ownerRule("proxy"));
    } else {
      const ports = [
        ...new Set(
          request.allowNetwork.flatMap(({ ports }) =>
            getExplicitNetworkPorts(ports),
          ),
        ),
      ].sort((left, right) => left - right);
      for (const port of ports) {
        commands.push([
          "-A",
          "OUTPUT",
          "-p",
          "tcp",
          "--dport",
          String(port),
          "-m",
          "owner",
          "--uid-owner",
          "proxy",
          "-j",
          "ACCEPT",
        ]);
      }
    }
  }
  commands.push(
    [
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
    ],
    ["-A", "OUTPUT", "-j", "REJECT", "--reject-with", "icmp-port-unreachable"],
  );
  return commands;
}

/** @testonly */
export function buildIpv6FirewallPlan(
  request: NetworkBootstrapRequest,
  upstreamDns: string | undefined,
): FirewallCommandPlan {
  if (!request.enabled) return [];
  const commands: Array<readonly string[]> = [...IPV6_CONFIGURATION_RULES];
  if (request.noProxy) {
    commands.push(ownerRule("sandbox"));
  } else if (upstreamDns?.includes(":")) {
    const [address, interfaceName] = upstreamDns.split("%", 2);
    if (!address || !interfaceName) {
      throw new Error(
        "The upstream IPv6 DNS resolver must include a guest interface scope.",
      );
    }
    for (const protocol of ["udp", "tcp"] as const) {
      commands.push([
        "-A",
        "OUTPUT",
        "-p",
        protocol,
        "-d",
        address,
        "-o",
        interfaceName,
        "--dport",
        "53",
        "-m",
        "owner",
        "--uid-owner",
        "dnsmasq",
        "-j",
        "ACCEPT",
      ]);
    }
  }
  commands.push(
    [
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
    ],
    ["-A", "OUTPUT", "-j", "REJECT", "--reject-with", "icmp6-port-unreachable"],
  );
  return commands;
}
