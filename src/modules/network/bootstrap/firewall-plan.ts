import {
  allowsAllNetworkPorts,
  getExplicitNetworkPorts,
} from "#modules/configuration/index.js";
import type { NetworkBootstrapRequest } from "./bootstrap-request-parsing.js";

/** @testonly */
export type FirewallCommandPlan = readonly (readonly string[])[];

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
  ["-A", "OUTPUT", "-d", "127.0.0.0/8", "-j", "ACCEPT"],
  ["-A", "OUTPUT", "-d", "10.0.0.0/8", "-j", "ACCEPT"],
  ["-A", "OUTPUT", "-d", "172.16.0.0/12", "-j", "ACCEPT"],
  ["-A", "OUTPUT", "-d", "192.168.0.0/16", "-j", "ACCEPT"],
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
