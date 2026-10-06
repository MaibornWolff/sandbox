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

async function removeFirewallRule(options: {
  readonly containers: SandboxInstanceOperations;
  readonly containerId: string;
  readonly command: readonly string[];
}): Promise<void> {
  const { containers, containerId, command } = options;
  const result = await containers.exec(containerId, { command, user: "root" });
  if (result.exitCode === 0) return;
  throw Object.assign(
    new Error(
      `Failed to remove host-command broker network access with exit code ${result.exitCode}.`,
    ),
    { exitCode: result.exitCode },
  );
}

export class ContainerReadinessError extends Error {}

async function reportReadinessFailure(options: {
  readonly containers: SandboxInstanceOperations;
  readonly containerId: string;
  readonly timeoutMs: number;
  readonly failure?: { readonly error: unknown };
}): Promise<never> {
  const { containers, containerId, timeoutMs, failure } = options;
  const logger = getLogger();
  const inspection = await containers
    .inspect(containerId)
    .catch((error: unknown) => {
      logger.warn(
        `Could not inspect failed session: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw failure ? failure.error : error;
    });
  if (
    failure &&
    inspection &&
    inspection.state !== "exited" &&
    inspection.state !== "dead"
  ) {
    throw failure.error;
  }
  if (inspection) {
    logger.error(`Container status: ${inspection.state}`);
    await containers.readLogs(containerId, { tail: 50 }).then(
      (logs) => logger.error(`Container logs:\n${logs}`),
      (error: unknown) =>
        logger.warn(
          `Could not read startup logs: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  } else {
    logger.error(
      "Container no longer exists. It probably crashed and was removed.",
    );
  }
  const message =
    inspection?.state === "running"
      ? `readiness timed out after ${timeoutMs}ms`
      : `container state is ${inspection?.state ?? "missing"}`;
  throw new ContainerReadinessError(
    `Container ${containerId} failed during startup: ${message}`,
  );
}

async function cleanFailedSession(
  containers: SandboxInstanceOperations,
  containerId: string,
  plan: HostCommandFirewallPlan | undefined,
): Promise<void> {
  if (!plan) return;
  await removeFirewallRule({
    containers,
    containerId,
    command: plan.remove,
  }).catch((error: unknown) =>
    getLogger().warn(
      `Could not remove the failed session's firewall rule: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
}

export async function prepareContainerSession(options: {
  readonly containers: SandboxInstanceOperations;
  readonly containerId: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}): Promise<AsyncDisposable> {
  const { containers, containerId, endpoint, timeoutMs = 30_000 } = options;
  const plan = endpoint
    ? buildHostCommandFirewallPlan(endpoint, crypto.randomUUID())
    : undefined;
  const logger = getLogger();
  const attempts = Math.max(1, Math.ceil(timeoutMs / 50));
  const ready = "sandbox-session-ready";
  const script =
    `i=0; while [ ! -f /tmp/.sandbox-ready ]; do ` +
    `i=$((i + 1)); [ "$i" -ge ${attempts} ] && exit 124; sleep 0.05; done; ` +
    `printf '%s\\n' '${ready}'; ` +
    'if [ "$#" -gt 0 ]; then exec /usr/bin/timeout --signal=KILL 5 "$@"; fi';
  logger.debug(`Preparing container session for ${chalk.cyan(containerId)}`);
  const result = await containers
    .exec(containerId, {
      command: ["sh", "-c", script, "sandbox-session", ...(plan?.add ?? [])],
      ...(plan ? { user: "root" } : {}),
    })
    .catch(async (error: unknown) => {
      await cleanFailedSession(containers, containerId, plan);
      return reportReadinessFailure({
        containers,
        containerId,
        timeoutMs,
        failure: { error },
      });
    });
  if (result.exitCode !== 0) {
    await cleanFailedSession(containers, containerId, plan);
    if (!result.stdout.split("\n").includes(ready)) {
      const failure =
        result.exitCode === 124
          ? undefined
          : {
              error: Object.assign(
                new Error(
                  `Failed to prepare container session with exit code ${result.exitCode}: ${result.stderr.trim() || "runtime returned no readiness confirmation"}`,
                ),
                { exitCode: result.exitCode },
              ),
            };
      return reportReadinessFailure({
        containers,
        containerId,
        timeoutMs,
        failure,
      });
    }
    throw Object.assign(
      new Error(
        `Failed to add host-command broker network access with exit code ${result.exitCode}.`,
      ),
      { exitCode: result.exitCode },
    );
  }
  if (!plan) return { async [Symbol.asyncDispose]() {} };
  return {
    async [Symbol.asyncDispose]() {
      logger.debug(
        `Removing host-command network access for ${chalk.cyan(containerId)}`,
      );
      try {
        await removeFirewallRule({
          containers,
          containerId,
          command: plan.remove,
        });
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
