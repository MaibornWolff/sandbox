import * as fs from "node:fs";
import * as path from "node:path";
import { stringify as stringifyToml } from "smol-toml";
import type { CommandPattern } from "#modules/host-command-escape/index.js";
import type { AllowedNetwork, Config } from "../config.js";
import { createConfigFromDefaults } from "../config-defaults.js";
import { parseAllowedNetwork } from "../config-value-parsing.js";
import {
  ALL_NETWORK_PORTS,
  allowsAllNetworkPorts,
} from "../network-port-selection.js";
import { trustProject } from "../project-trust.js";
import { loadTomlConfig } from "../toml-config-loading.js";

interface TrustedProjectConfigOptions {
  readonly projectRoot: string;
  readonly trustStorePath: string;
  readonly allowNetwork?: readonly AllowedNetwork[];
  readonly allowHostCommands?: readonly CommandPattern[];
  readonly runtime?: "docker" | "podman";
  readonly content?: string;
}

function formatAllowedNetwork(entry: AllowedNetwork): string {
  const host = entry.wildcard ? `*.${entry.host}` : entry.host;
  if (allowsAllNetworkPorts(entry.ports)) {
    return `${host}:${ALL_NETWORK_PORTS}`;
  }
  const ports = [...entry.ports].sort((left, right) => left - right);
  if (
    ports.length === 0 ||
    (ports.length === 2 && ports[0] === 80 && ports[1] === 443)
  ) {
    return host;
  }
  return ports.length === 1
    ? `${host}:${ports[0]}`
    : `${host}:{${ports.join(",")}}`;
}

export function readConfigFixture(filePath: string): Config {
  const parsed = loadTomlConfig(filePath);
  const config = createConfigFromDefaults(parsed?.runtime ?? "docker");
  config.allowNetwork = (parsed?.allow_network ?? []).map(parseAllowedNetwork);
  config.allowHostCommands = (parsed?.allow_host_commands ?? []).map(
    (rule) => rule.pattern,
  );
  return config;
}

export function writeTrustedProjectConfig(
  options: TrustedProjectConfigOptions,
): void {
  const sandboxDirectory = path.join(options.projectRoot, ".sandbox");
  fs.mkdirSync(sandboxDirectory, { recursive: true });
  const values = (options.allowNetwork ?? []).map(formatAllowedNetwork);
  const lines = values.map((value) => `  ${JSON.stringify(value)},`).join("\n");
  const runtimeLine = options.runtime
    ? `runtime = ${JSON.stringify(options.runtime)}\n`
    : "";
  const hostCommands = stringifyToml({
    allow_host_commands: (options.allowHostCommands ?? []).map((pattern) => ({
      pattern,
    })),
  });
  fs.writeFileSync(
    path.join(sandboxDirectory, "config.toml"),
    options.content ??
      `${runtimeLine}allow_network = [\n${lines}\n]\n${hostCommands}`,
  );
  trustProject(
    options.projectRoot,
    sandboxDirectory,
    options.trustStorePath,
    "2026-01-01T00:00:00.000Z",
  );
}
