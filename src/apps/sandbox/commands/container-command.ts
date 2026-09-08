import type { Command } from "commander";
import { containerStartCommand } from "#modules/sandbox-containers/index.js";
import { requireHost } from "../host-environment.js";
import { mergeCliOptions } from "./cli-options.js";

export function registerContainerCommands(program: Command): void {
  const container = program
    .command("container")
    .description("Container management and debugging");

  container
    .command("start")
    .description(
      "Start container in foreground (non-detached, for debugging startup issues)",
    )
    .addHelpText(
      "after",
      "\nExample:\n  $ sandbox container start --no-build\n",
    )
    .action(async (options, cmd) => {
      requireHost("container start");
      const globalOpts = cmd.parent?.parent?.opts() ?? {};
      await containerStartCommand(mergeCliOptions(globalOpts, options));
    });
}
