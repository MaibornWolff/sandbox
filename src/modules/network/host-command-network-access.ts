import * as crypto from "node:crypto";
import chalk from "chalk";
import type { SandboxInstanceOperations } from "#platform/container-runtime/index.js";
import { getLogger } from "#platform/logging/index.js";

const IPTABLES = "/usr/sbin/iptables";

interface HostCommandFirewallPlan {
  readonly add: readonly string[];
  readonly remove: readonly string[];
}

function parseEndpoint(endpoint: string): {
  readonly host: string;
  readonly port: number;
} {
  const url = new URL(endpoint);
  const port = Number(url.port);
  if (
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    !url.hostname ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("The host-command broker endpoint is invalid.");
  }
  return { host: url.hostname, port };
}

/** @testonly */
export function buildHostCommandFirewallPlan(
  endpoint: string,
  ruleId: string,
): HostCommandFirewallPlan {
  const { host, port } = parseEndpoint(endpoint);
  const match = [
    "OUTPUT",
    "-p",
    "tcp",
    "-d",
    host,
    "--dport",
    String(port),
    "-m",
    "owner",
    "--uid-owner",
    "sandbox",
    "-m",
    "comment",
    "--comment",
    `sandbox-host-command-${ruleId}`,
    "-j",
    "ACCEPT",
  ];
  return {
    add: [IPTABLES, "-I", ...match.slice(0, 1), "1", ...match.slice(1)],
    remove: [IPTABLES, "-D", ...match],
  };
}

async function runFirewallCommand(
  containers: SandboxInstanceOperations,
  containerId: string,
  command: readonly string[],
  action: string,
): Promise<void> {
  const result = await containers.exec(containerId, { command, user: "root" });
  if (result.exitCode === 0) return;
  throw Object.assign(
    new Error(
      `Failed to ${action} host-command broker network access with exit code ${result.exitCode}.`,
    ),
    { exitCode: result.exitCode },
  );
}

export async function allowHostCommandNetworkAccess(
  containers: SandboxInstanceOperations,
  containerId: string,
  endpoint: string,
): Promise<AsyncDisposable> {
  const plan = buildHostCommandFirewallPlan(endpoint, crypto.randomUUID());
  const logger = getLogger();
  await runFirewallCommand(containers, containerId, plan.add, "add");
  return {
    async [Symbol.asyncDispose]() {
      try {
        await runFirewallCommand(
          containers,
          containerId,
          plan.remove,
          "remove",
        );
      } catch (error) {
        const instance = await containers.inspect(containerId);
        const namespaceEnded =
          instance === null ||
          instance.state === "exited" ||
          instance.state === "dead";
        if (!namespaceEnded) throw error;
        logger.debug(
          `Host-command network access ended with container ${chalk.cyan(containerId)}`,
        );
      }
    },
  };
}
