import { Command } from "commander";
import { runCommand, runShell } from "#modules/sandbox-containers/index.js";
import {
  getVersion,
  warnIfUpdateAvailable,
} from "#modules/self-update/index.js";
import { getLogger } from "#platform/logging/index.js";
import { registerAssistCommand } from "./commands/assist-command.js";
import {
  configureGlobalOptions,
  mergeCliOptions,
  normalizeCliOptions,
  validateRunOptions,
} from "./commands/cli-options.js";
import { registerConfigCommands } from "./commands/config-command.js";
import { registerContainerCommands } from "./commands/container-command.js";
import { registerEscapeCommand } from "./commands/escape-command.js";
import { registerLifecycleCommands } from "./commands/lifecycle-command.js";
import { registerNetworkCommands } from "./commands/network-command.js";
import {
  displaySandboxInfo,
  isInsideSandbox,
  requireHost,
} from "./host-environment.js";

/**
 * Register all CLI subcommands
 */
function registerCommands(program: Command): void {
  program.action(async (options, cmd) => {
    const unknownArgs = cmd.args.filter((arg: string) => !arg.startsWith("-"));
    if (unknownArgs.length > 0) {
      cmd.error(`error: unknown command '${unknownArgs[0]}'`);
    }
    if (isInsideSandbox()) {
      displaySandboxInfo();
      return;
    }
    warnIfUpdateAvailable();
    await runShell(normalizeCliOptions(options));
  });

  program
    .command("run")
    .description("Run command in sandbox")
    .argument("<command...>", "Command to run")
    .option(
      "-s, --silent",
      "Suppress Sandbox logs while preserving command output",
    )
    .allowUnknownOption()
    .addHelpText(
      "after",
      `
Examples:
  $ sandbox run claude
  $ sandbox run --no-build claude
  $ sandbox run -- sh -c 'echo "$HOME"'
  $ sandbox run -- curl -fsS https://example.com

Note:
  Use '--' before commands that include flags (for example: '-c').
`,
    )
    .action(async (command, options, cmd) => {
      requireHost("run");
      const globalOpts = cmd.parent.opts();
      const mergedOptions = mergeCliOptions(globalOpts, options);
      validateRunOptions(mergedOptions, cmd);
      if (mergedOptions.silent) {
        getLogger().setSilent(true);
      }
      if (!mergedOptions.silent) warnIfUpdateAvailable();
      await runCommand(command, mergedOptions);
    });

  registerEscapeCommand(program);
  registerLifecycleCommands(program);
  registerConfigCommands(program);
  registerAssistCommand(program);
  registerNetworkCommands(program);
  registerContainerCommands(program);
}

/**
 * Run the CLI program
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name("sandbox")
    .description("Container sandbox CLI for coding agents")
    .version(getVersion())
    .allowExcessArguments();
  program.configureHelp({ showGlobalOptions: true });

  program.hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) {
      getLogger().setVerbose(true);
    }
  });

  configureGlobalOptions(program);
  registerCommands(program);

  if (isInsideSandbox()) {
    program.addHelpText(
      "after",
      "\nRunning inside sandbox. Some commands are host-only. Run 'sandbox' for info.\n",
    );
  }

  return program;
}
