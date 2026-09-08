import path from "node:path";
import { getSandboxEnvironment } from "#platform/environment/index.js";
import { readTextFile } from "#platform/filesystem/index.js";
import { executeContainerCommand } from "./command.js";

export type ContainerLogSource =
  | "firewall"
  | "dns"
  | "proxy-access"
  | "proxy-cache";

const LOG_SOURCES: Record<
  ContainerLogSource,
  { readonly path: string; readonly missingOutput: string }
> = {
  firewall: {
    path: "/var/log/firewall-blocked.log",
    missingOutput: "No blocked requests recorded.\n",
  },
  dns: { path: "/var/log/dns-proxy.log", missingOutput: "" },
  "proxy-access": {
    path: "/var/log/proxy-access.log",
    missingOutput: "Proxy log file not found: /var/log/proxy-access.log\n",
  },
  "proxy-cache": { path: "/var/log/squid-cache.log", missingOutput: "" },
};

function containerPath(absolutePath: string): string {
  return path.join(
    getSandboxEnvironment().filesystemRoot,
    absolutePath.replace(/^\/+/, ""),
  );
}

export function readContainerLog(source: ContainerLogSource): string {
  const definition = LOG_SOURCES[source];
  try {
    const content = readTextFile(containerPath(definition.path));
    return content.length > 0 ? content : definition.missingOutput;
  } catch {
    return definition.missingOutput;
  }
}

async function captureBestEffort(
  command: string,
  args: string[],
): Promise<string> {
  try {
    return await executeContainerCommand(command, args);
  } catch (error) {
    return error instanceof Error ? `${error.message}\n` : `${String(error)}\n`;
  }
}

function section(title: string, content: string): string {
  return `\n--- ${title} ---\n${content}`;
}

function readBestEffort(filePath: string): string {
  try {
    return readTextFile(containerPath(filePath));
  } catch (error) {
    return error instanceof Error ? `${error.message}\n` : `${String(error)}\n`;
  }
}

export async function collectPassiveNetworkState(): Promise<string> {
  const [date, uptime, routes, addresses, processes, sockets, firewall] =
    await Promise.all([
      captureBestEffort("date", ["-u"]),
      captureBestEffort("uptime", []),
      captureBestEffort("ip", ["route"]),
      captureBestEffort("ip", ["-brief", "address"]),
      Promise.all(
        ["dnsmasq", "squid", "tcpdump"].map(async (processName) => {
          try {
            const output = await executeContainerCommand("pgrep", [
              "-a",
              processName,
            ]);
            return output.length > 0
              ? output
              : `${processName}: not running or process status unavailable\n`;
          } catch {
            return `${processName}: not running or process status unavailable\n`;
          }
        }),
      ).then((outputs) => outputs.join("")),
      captureBestEffort("ss", ["-lntup"]),
      captureBestEffort("iptables", ["-S", "OUTPUT"]),
    ]);

  return [
    section("TIME", `${date}${uptime}`),
    section(
      "RESOLVER",
      `/etc/resolv.conf:\n${readBestEffort("/etc/resolv.conf")}/etc/resolv.conf.upstream:\n${readBestEffort("/etc/resolv.conf.upstream")}`,
    ),
    section("ROUTES", routes),
    section("ADDRESSES", addresses),
    section("NETWORK PROCESSES", processes),
    section("LISTENING SOCKETS", sockets),
    section("FIREWALL OUTPUT RULES", firewall),
  ].join("");
}
