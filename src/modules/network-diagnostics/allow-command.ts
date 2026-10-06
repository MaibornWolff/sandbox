import chalk from "chalk";
import {
  type ConfigOverrides,
  getConfigurationService,
  getGlobalConfigPath,
  getProjectConfigPath,
  getProjectSandboxDir,
} from "#modules/configuration/index.js";
import { getClock } from "#platform/clock/index.js";
import { getRuntimeProvider } from "#platform/container-runtime/index.js";
import { pathExists } from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import {
  getTerminal,
  selectCheckbox,
  selectOne,
} from "#platform/terminal/index.js";
import { generateProjectSlug } from "#shared/text/index.js";
import { deriveAllowDomainChoices } from "./allow-domain-selection.js";
import { findNetworkContainers } from "./container-discovery.js";
import { collectContainerEntries } from "./network-log-collection.js";

type ConfigTarget = "global" | "project";

export async function networkAllowCommand(
  options: ConfigOverrides,
): Promise<void> {
  const configuration = getConfigurationService();
  const runtimeProvider = getRuntimeProvider();
  const terminal = getTerminal();
  const logger = getLogger();
  const clock = getClock();
  const { config, projectRoot, runtimeResolution } =
    await configuration.load(options);
  const { runtime } = await runtimeProvider.resolve(runtimeResolution);

  const containers = await findNetworkContainers(runtime, {
    status: "running",
    projectSlug: generateProjectSlug(projectRoot),
  });
  if (containers.length === 0) {
    logger.info("No running sandbox containers found.");
    return;
  }

  const allEntries = [];
  for (const container of containers) {
    const entries = await collectContainerEntries(
      runtime,
      container,
      true,
      clock.now(),
    );
    allEntries.push(...entries);
  }

  const choices = deriveAllowDomainChoices(allEntries, config.allowNetwork);
  if (choices.length === 0) {
    logger.info("No blocked network requests found.");
    return;
  }
  if (choices.every((choice) => choice.disabled)) {
    logger.info(
      "All blocked domains are configured. Restart the sandbox to apply the current policy.",
    );
    return;
  }

  const selected = await selectCheckbox({
    message: "Select domains to allow:",
    choices,
    pageSize: 20,
    loop: false,
  });
  if (selected.length === 0) return;

  const hasProjectDir = pathExists(getProjectSandboxDir(projectRoot));
  let targetType: ConfigTarget = "global";
  if (hasProjectDir) {
    targetType = await selectOne<ConfigTarget>({
      message: "Add to which config?",
      choices: [
        {
          value: "global",
          name: "Global config",
          description: getGlobalConfigPath(),
        },
        {
          value: "project",
          name: "Project config",
          description: getProjectConfigPath(projectRoot),
        },
      ],
    });
  }

  const targetPath =
    targetType === "project"
      ? getProjectConfigPath(projectRoot)
      : getGlobalConfigPath();
  configuration.updateAllowedNetwork({
    target: targetType,
    projectRoot,
    domains: selected,
  });

  terminal.stdout.write(`\nAdded to ${chalk.cyan(targetPath)}:\n`);
  for (const domain of selected) {
    terminal.stdout.write(`  ${chalk.green("+")} ${domain}\n`);
  }
}
