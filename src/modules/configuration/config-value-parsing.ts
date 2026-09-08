import { splitColonString, windowsPathToDocker } from "#shared/text/index.js";
import type { AllowedNetwork } from "./config.js";
import {
  ALL_NETWORK_PORTS,
  isNetworkPort,
  type NetworkPortSelection,
} from "./network-port-selection.js";

const DEFAULT_PORTS = [80, 443];

function parseNetworkPort(value: string, input: string): number {
  const port = Number.parseInt(input, 10);
  if (!isNetworkPort(port)) {
    throw new Error(`Invalid port number in '${value}': ${input}`);
  }
  return port;
}

function parsePortSet(value: string, input: string): NetworkPortSelection {
  if (input === "") throw new Error(`Empty port list in '${value}'`);
  const members = input.split(",").map((member) => member.trim());
  if (!members.includes(ALL_NETWORK_PORTS)) {
    return members.map((member) => parseNetworkPort(value, member));
  }
  if (members.length === 1) return ALL_NETWORK_PORTS;
  throw new Error(
    `Invalid wildcard port set in '${value}': '*' must be the only port`,
  );
}

function parseNetworkPorts(value: string, input: string): NetworkPortSelection {
  if (input === ALL_NETWORK_PORTS) return ALL_NETWORK_PORTS;
  const isPortSet = input.startsWith("{") && input.endsWith("}");
  if (!isPortSet) return [parseNetworkPort(value, input)];
  return parsePortSet(value, input.slice(1, -1).trim());
}

export function parseAllowedNetwork(value: string): AllowedNetwork {
  let wildcard = false;
  let input = value;
  if (input.startsWith("*.")) {
    wildcard = true;
    input = input.slice(2);
  }

  const colonIndex = input.indexOf(":");
  const host = colonIndex === -1 ? input : input.slice(0, colonIndex);
  if (host.includes("*")) {
    throw new Error(
      `Invalid wildcard in '${value}': wildcards are only supported as a '*.domain.com' prefix`,
    );
  }
  if (colonIndex === -1) {
    return { host, ports: DEFAULT_PORTS, wildcard };
  }

  const portPart = input.slice(colonIndex + 1);
  return { host, ports: parseNetworkPorts(value, portPart), wildcard };
}

export function parseMount(value: string): string {
  const parts = splitColonString(value);
  const source = parts[0] ?? "";
  if (parts.length === 1) {
    return `${source}:${windowsPathToDocker(source)}:ro`;
  }
  if (parts.length === 2) {
    const secondPart = parts[1];
    if (secondPart === "rw" || secondPart === "ro") {
      return `${source}:${windowsPathToDocker(source)}:${secondPart}`;
    }
    return `${source}:${parts[1]}:ro`;
  }
  return value;
}

export function parsePort(value: string): string {
  const parts = value.split(":");
  return parts.length === 1 ? `${parts[0]}:${parts[0]}` : value;
}
