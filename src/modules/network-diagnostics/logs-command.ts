import chalk from "chalk";
import type { ConfigOverrides } from "#modules/configuration/index.js";
import { getConfigurationService } from "#modules/configuration/index.js";
import {
  findSandboxContainers,
  type SandboxContainer,
} from "#modules/sandbox-containers/index.js";
import { getClock } from "#platform/clock/index.js";
import type { SandboxRuntime } from "#platform/container-runtime/index.js";
import { getRuntimeProvider } from "#platform/container-runtime/index.js";
import type { ContainerLogSource } from "#platform/container-system/index.js";
import { getLogger } from "#platform/logging/index.js";
import { getTerminal } from "#platform/terminal/index.js";
import { getErrorMessage } from "#shared/errors/index.js";
import { generateProjectSlug } from "#shared/text/index.js";
import { formatRelativeTime } from "#shared/time/index.js";
import {
  buildContainerNetworkStateCommand,
  execContainerDiagnostic,
  fetchContainerLogBundle,
} from "./container-diagnostic-commands.js";
import type {
  NetworkConnectionStatus,
  NetworkDiagnostic,
  NetworkLogEntry,
} from "./network-diagnostics.js";
import { collectContainerEntries } from "./network-log-collection.js";
import {
  buildRawDiagnosticSections,
  prepareNetworkLogEntries,
  type RawDiagnosticSection,
} from "./network-log-presentation.js";

interface NetworkLogsOptions extends ConfigOverrides {
  readonly status?: "all" | "blocked";
  readonly raw?: boolean;
  readonly resolve?: boolean;
}

async function collectDiagnostic(
  operation: () => Promise<string>,
): Promise<NetworkDiagnostic> {
  try {
    return { output: await operation() };
  } catch (error) {
    return {
      output: "",
      error: getErrorMessage(error),
    };
  }
}

async function collectLogDiagnostics(
  service: SandboxRuntime,
  containerId: string,
): Promise<Readonly<Record<ContainerLogSource, NetworkDiagnostic>>> {
  try {
    const logs = await fetchContainerLogBundle(service, containerId);
    return {
      firewall: { output: logs.firewall },
      dns: { output: logs.dns },
      "proxy-access": { output: logs["proxy-access"] },
      "proxy-cache": { output: logs["proxy-cache"] },
    };
  } catch (error) {
    const failure: NetworkDiagnostic = {
      output: "",
      error: getErrorMessage(error),
    };
    return {
      firewall: failure,
      dns: failure,
      "proxy-access": failure,
      "proxy-cache": failure,
    };
  }
}

function formatStatus(status: NetworkConnectionStatus): string {
  return status === "ALLOWED" ? chalk.green(status) : chalk.red(status);
}

function renderTable(entries: readonly NetworkLogEntry[], now: number): string {
  if (entries.length === 0) return chalk.dim("No network requests recorded.");

  const containerWidth = 22;
  const minDestinationWidth = 34;
  const portWidth = 6;
  const countWidth = 6;
  const lastSeenWidth = 10;
  const destinationWidth = Math.max(
    minDestinationWidth,
    ...entries.map(
      (entry) =>
        (entry.destination !== entry.dstIp
          ? entry.destination.length
          : entry.dstIp.length) + 1,
    ),
  );
  const lines = [
    chalk.dim(
      `${"CONTAINER".padEnd(containerWidth)}${"DESTINATION".padEnd(destinationWidth)}${"PORT".padEnd(portWidth)}${"COUNT".padEnd(countWidth)}${"LAST SEEN".padEnd(lastSeenWidth)}STATUS`,
    ),
  ];

  for (const entry of entries) {
    const shortId = entry.container.substring(0, 8);
    const destination =
      entry.destination !== entry.dstIp
        ? chalk.cyan(entry.destination) +
          " ".repeat(destinationWidth - entry.destination.length)
        : chalk.yellow(entry.dstIp.padEnd(destinationWidth));
    const port = (entry.port === 0 ? "DNS" : String(entry.port)).padEnd(
      portWidth,
    );
    const count = String(entry.count).padEnd(countWidth);
    const lastSeen = formatRelativeTime(entry.lastSeen, now).padEnd(
      lastSeenWidth,
    );
    lines.push(
      `${shortId.padEnd(containerWidth)}${destination}${port}${count}${chalk.dim(lastSeen)}${formatStatus(entry.status)}`,
    );
  }
  return lines.join("\n");
}

function renderRawLogs(
  container: SandboxContainer,
  sections: readonly RawDiagnosticSection[],
): string {
  const colors = {
    blue: chalk.blue,
    cyan: chalk.cyan,
    magenta: chalk.magenta,
    red: chalk.red,
    yellow: chalk.yellow,
  };
  const lines = [
    "",
    `${chalk.bold("Container:")} ${chalk.cyan(container.id.substring(0, 12))} ${chalk.dim(`(${container.image})`)}`,
    "",
  ];
  for (const section of sections) {
    lines.push(colors[section.tone](`=== ${section.title} ===`));
    if (section.diagnostic.error) {
      lines.push(
        chalk.red(`Failed to collect diagnostic: ${section.diagnostic.error}`),
      );
    } else if (section.diagnostic.output.trim()) {
      lines.push(chalk.dim(section.diagnostic.output));
    } else {
      lines.push(chalk.dim("(empty)"));
    }
  }
  return lines.join("\n");
}

async function collectRawSections(
  service: SandboxRuntime,
  containerId: string,
): Promise<readonly RawDiagnosticSection[]> {
  const [runtimeLog, networkState, logs] = await Promise.all([
    collectDiagnostic(() =>
      service.instances.readLogs(containerId, { tail: 200 }),
    ),
    collectDiagnostic(() =>
      execContainerDiagnostic(
        service,
        containerId,
        buildContainerNetworkStateCommand(),
      ),
    ),
    collectLogDiagnostics(service, containerId),
  ]);
  return buildRawDiagnosticSections({
    runtimeLog,
    networkState,
    firewall: logs.firewall,
    dns: logs.dns,
    proxyAccess: logs["proxy-access"],
    proxyCache: logs["proxy-cache"],
  });
}

export async function networkBlockedCommand(
  options: NetworkLogsOptions,
): Promise<void> {
  const configuration = getConfigurationService();
  const runtimeProvider = getRuntimeProvider();
  const logger = getLogger();
  const terminal = getTerminal();
  const clock = getClock();
  const { projectRoot, runtimeResolution } = await configuration.load(options);
  const { runtime } = await runtimeProvider.resolve(runtimeResolution);
  const containers = await findSandboxContainers(runtime, {
    status: "running",
    projectSlug: generateProjectSlug(projectRoot),
  });

  if (containers.length === 0) {
    logger.info("No running sandbox containers found for this project.");
    return;
  }

  if (options.raw) {
    for (const container of containers) {
      logger.debug(
        `Collecting raw network diagnostics from ${chalk.cyan(container.id.substring(0, 12))}`,
      );
      terminal.stdout.write(
        `${renderRawLogs(container, await collectRawSections(runtime, container.id))}\n`,
      );
    }
    return;
  }

  const allEntries: NetworkLogEntry[] = [];
  for (const container of containers) {
    allEntries.push(
      ...(await collectContainerEntries(
        runtime,
        container,
        options.resolve !== false,
        clock.now(),
      )),
    );
  }
  const showAllowed = options.status === "all";
  const visible = prepareNetworkLogEntries(allEntries, { showAllowed });
  terminal.stdout.write(`\n${renderTable(visible, clock.now())}\n\n`);
  if (!showAllowed) {
    terminal.stdout.write(
      `${chalk.dim("Note: Use --status=all to also show allowed requests.")}\n`,
    );
  }
  terminal.stdout.write(
    `${chalk.dim("Tip:")}  Run ${chalk.cyan("sandbox network allow")} to interactively add domains to config\n`,
  );
}
