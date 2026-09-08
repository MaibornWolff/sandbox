import { type Command, Option } from "commander";
import {
  networkAllowCommand,
  networkBlockedCommand,
} from "#modules/network-diagnostics/index.js";
import { requireHost } from "../host-environment.js";

export function registerNetworkCommands(program: Command): void {
  const network = program
    .command("network")
    .description("Network diagnostics")
    .addHelpText(
      "after",
      `
Examples:
  $ sandbox network logs              # Show blocked requests
  $ sandbox network logs --status=all # Show all requests (blocked + allowed)
  $ sandbox network allow             # Interactively add domains to config
`,
    );

  network
    .command("logs")
    .alias("l")
    .description("Show firewall logs")
    .addOption(
      new Option("--status <mode>", "Filter by status")
        .choices(["all", "blocked"])
        .default("blocked"),
    )
    .option("--raw", "Show full raw network diagnostic bundle")
    .option("--no-resolve", "Skip reverse DNS lookup")
    .action(async (options, cmd) => {
      requireHost("network logs");
      const globalOpts = cmd.parent?.parent?.opts() ?? {};
      await networkBlockedCommand({ ...globalOpts, ...options });
    });

  network
    .command("allow")
    .description("Interactively add domains from logs to config")
    .action(async (_options, cmd) => {
      requireHost("network allow");
      const globalOpts = cmd.parent?.parent?.opts() ?? {};
      await networkAllowCommand(globalOpts);
    });
}
