import chalk from "chalk";
import { getContainerRuntimeDirectory } from "#modules/sandbox-runtime/index.js";
import { getVersion } from "#modules/self-update/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { getTerminal } from "#platform/terminal/index.js";

class HostOnlyCommandError extends Error {
  readonly exitCode = 1;
  readonly reported = true;
}

export function isInsideSandbox(): boolean {
  return getHostEnvironment().variables.SANDBOX === "1";
}

export function requireHost(commandName: string): void {
  if (!isInsideSandbox()) return;

  getTerminal().stderr.write(
    `${chalk.bold(`sandbox ${commandName}`)} is only available on the host (outside the sandbox).\n` +
      `Run ${chalk.cyan("sandbox")} for available commands and documentation paths.\n`,
  );
  throw new HostOnlyCommandError(`sandbox ${commandName} is host-only`);
}

export function displaySandboxInfo(): void {
  const version = getVersion();
  const runtimeDirectory = getContainerRuntimeDirectory();

  getTerminal().stdout.write(`
${chalk.bold("Sandbox")} - Docker-based isolation for AI coding agents
Version: ${chalk.cyan(version)}

You are inside a sandboxed Docker container.
The sandbox provides file isolation, network filtering, and state persistence.

${chalk.bold("Documentation:")}
  ${chalk.dim(`${runtimeDirectory}/docs/`)}                   Architecture and concepts
  ${chalk.cyan("sandbox config schema")}                     Config options reference
  ${chalk.dim(`${runtimeDirectory}/README.md`)}               Getting started & troubleshooting

${chalk.bold("Commands available inside the sandbox:")}
  ${chalk.cyan("sandbox --help")}              Show all commands and options
  ${chalk.cyan("sandbox config schema")}       Show configuration schema reference
  ${chalk.cyan("sandbox escape --list")}        List allowed host command patterns
  ${chalk.cyan("sandbox escape -- <command>")} Run an allowed command on the host
  ${chalk.cyan("sandbox assist [question]")}   Get AI-assisted help with sandbox setup

${chalk.bold("Troubleshooting:")}
  See ${chalk.dim(`${runtimeDirectory}/README.md`)} (search for "Troubleshooting")
  Common issues: network blocks, permission errors, build failures, missing agents

${chalk.bold("Configuration")} is managed on the host. Key paths:
  ${chalk.dim("~/.config/sandbox/config.toml")}    Global config
  ${chalk.dim(".sandbox/config.toml")}             Project config (in project root)
  ${chalk.dim("~/.config/sandbox/docker/")}        Custom Dockerfile layers
  ${chalk.dim("~/.config/sandbox/settings/")}      Shared settings (synced into container)

To modify configuration, exit the sandbox and run:
  ${chalk.cyan("sandbox config show")}         View current merged configuration
  ${chalk.cyan("sandbox init")}                Re-initialize configuration
  ${chalk.cyan("sandbox doctor")}              Check environment health
`);
}
