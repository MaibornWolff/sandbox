import type { Command } from "commander";
import { formatConfigReference } from "#modules/configuration/index.js";
import { configUpdateCommand } from "#modules/workspace-setup/index.js";
import { getTerminal } from "#platform/terminal/index.js";
import { showConfig } from "../config-display.js";
import { requireHost } from "../host-environment.js";

export function registerConfigCommands(program: Command): void {
  const config = program
    .command("config")
    .description("Configuration management")
    .addHelpText(
      "after",
      "\nRun 'sandbox config schema' to see all configuration fields with types and defaults.\n",
    );

  config
    .command("show", { isDefault: true })
    .description("Show merged configuration")
    .action(async (_options, cmd) => {
      const globalOpts = cmd.parent?.parent?.opts() ?? {};
      await showConfig(globalOpts);
    });

  config
    .command("schema")
    .allowExcessArguments(false)
    .description(
      "Show all configuration fields with types, defaults, and merge rules",
    )
    .action(() => {
      getTerminal().stdout.write(`${formatConfigReference("text")}\n`);
    });

  config
    .command("update")
    .description("Update configuration from latest templates")
    .option(
      "-p, --project",
      "Update project-level config (instead of user-level)",
    )
    .action(async (options) => {
      requireHost("config update");
      await configUpdateCommand(options);
    });
}
