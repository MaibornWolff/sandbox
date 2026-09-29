import chalk from "chalk";
import { getConfigurationService } from "#modules/configuration/index.js";
import {
  type ContainerRuntime,
  getRuntimeProvider,
} from "#platform/container-runtime/index.js";
import { getLogger } from "#platform/logging/index.js";
import { confirmDestruction } from "#platform/terminal/index.js";
import { getErrorMessage } from "#shared/errors/index.js";
import { generateProjectSlug } from "#shared/text/index.js";
import type { SandboxContainer } from "../lifecycle/container-discovery.js";
import { findSandboxContainers } from "../lifecycle/container-discovery.js";
import type { SessionInfo } from "../lifecycle/container-status.js";
import { getSessionDetails } from "../lifecycle/container-status.js";
import type { StopOptions } from "../sandbox-options.js";

interface ContainerWithSessions {
  container: SandboxContainer;
  sessions: SessionInfo[];
}

async function gatherSessions(
  service: ContainerRuntime,
  containers: SandboxContainer[],
): Promise<ContainerWithSessions[]> {
  return Promise.all(
    containers.map(async (container) => ({
      container,
      sessions: await getSessionDetails(service, container.name),
    })),
  );
}

/** @testonly */
export function buildStopWarning(
  containersWithSessions: ContainerWithSessions[],
): string {
  const totalSessions = containersWithSessions.reduce(
    (sum, candidate) => sum + candidate.sessions.length,
    0,
  );
  const lines: string[] = [];
  const sessionSuffix =
    totalSessions > 0 ? ` with ${totalSessions} active session(s)` : "";
  lines.push(
    `This will stop and remove ${containersWithSessions.length} container(s)${sessionSuffix}:`,
    "",
  );

  for (const { container, sessions } of containersWithSessions) {
    const sessionLabel =
      sessions.length > 0
        ? `${sessions.length} session${sessions.length === 1 ? "" : "s"}`
        : "no sessions";
    lines.push(`  ${chalk.cyan(container.name)}  ${chalk.dim(sessionLabel)}`);
  }

  lines.push(
    "",
    totalSessions > 0
      ? "This will cancel all open sessions. Continue?"
      : "Continue?",
  );
  return lines.join("\n");
}

async function cancelContainerSessions(
  service: ContainerRuntime,
  containerId: string,
  sessions: readonly SessionInfo[],
): Promise<void> {
  if (sessions.length === 0) return;
  await service.execInContainer(containerId, [
    "kill",
    "-TERM",
    "--",
    ...sessions.map(({ pid }) => pid),
  ]);
}

/** @testonly */
export async function stopContainers(
  service: ContainerRuntime,
  containersWithSessions: readonly ContainerWithSessions[],
): Promise<number> {
  const logger = getLogger();
  let removed = 0;
  for (const { container, sessions } of containersWithSessions) {
    try {
      await cancelContainerSessions(service, container.id, sessions);
    } catch (error) {
      logger.warn(
        `Failed to cancel sessions in ${container.name} before stopping it: ${getErrorMessage(error)}`,
      );
    }
    try {
      await service.stopContainer(container.id);
      logger.success(`Stopped container: ${container.name}`);
      removed++;
    } catch (error) {
      logger.error(
        `Failed to stop container ${container.name}: ${getErrorMessage(error)}`,
      );
    }
  }
  return removed;
}

export async function stopCommand(options: StopOptions): Promise<void> {
  const logger = getLogger();
  const { projectRoot, configuredRuntime } =
    await getConfigurationService().load(options);
  const runtimeService = await getRuntimeProvider().resolve(configuredRuntime);
  const projectSlug = options.all
    ? undefined
    : generateProjectSlug(projectRoot);
  const containers = await findSandboxContainers(runtimeService, {
    status: "running",
    projectSlug,
  });

  if (containers.length === 0) {
    logger.info("No running sandbox containers");
    return;
  }

  const containersWithSessions = await gatherSessions(
    runtimeService,
    containers,
  );
  if (!options.force) {
    const confirmed = await confirmDestruction(
      buildStopWarning(containersWithSessions),
    );
    if (!confirmed) {
      logger.info("Cancelled");
      return;
    }
  }

  const removed = await stopContainers(runtimeService, containersWithSessions);
  logger.success(`Stopped ${removed} container(s)`);
}
