import { Argument, Command } from "commander";
import { getSandboxSettings } from "#modules/sandbox-settings/index.js";
import {
  type ContainerLogSource,
  collectPassiveNetworkState,
  diagnoseContainerX11,
  readContainerLog,
} from "#platform/container-system/index.js";
import { getTerminal } from "#platform/terminal/index.js";
import { runContainerEntrypoint } from "./entrypoint.js";

const NETWORK_DIAGNOSTIC_SOURCES = [
  "firewall",
  "dns",
  "proxy-access",
  "proxy-cache",
] as const satisfies readonly ContainerLogSource[];

export function createContainerToolsProgram(
  version: string,
  setExitCode: (exitCode: number) => void,
): Command {
  const program = new Command()
    .name("sandbox-container-tools")
    .description(
      "Internal container runtime support for @maibornwolff/sandbox.",
    )
    .version(version);

  program
    .command("version")
    .description("Print the version")
    .action(() => {
      getTerminal().stdout.write(`${version}\n`);
    });

  program
    .command("entrypoint [defaultCommand...]")
    .description("Run the container entrypoint")
    .action(async (defaultCommand: string[]) => {
      setExitCode(await runContainerEntrypoint(defaultCommand));
    });

  const network = program
    .command("network")
    .description("Inspect container networking");
  network
    .command("diagnostic")
    .description("Read a network diagnostic log")
    .addArgument(
      new Argument("<source>").choices([...NETWORK_DIAGNOSTIC_SOURCES]),
    )
    .action((source: ContainerLogSource) => {
      getTerminal().stdout.write(readContainerLog(source));
    });
  network
    .command("state")
    .description("Collect passive network state")
    .action(async () => {
      getTerminal().stdout.write(await collectPassiveNetworkState());
    });

  const settings = program
    .command("settings")
    .description("Manage container settings");
  settings
    .command("apply")
    .description("Apply copied settings at container startup")
    .action(async () => {
      await getSandboxSettings().applyOnContainerStart();
    });
  settings
    .command("sync")
    .description("Sync new mounted settings to the host")
    .action(async () => {
      await getSandboxSettings().syncNewSettingsOnContainerStop();
    });

  program
    .command("x11")
    .description("Inspect X11 connectivity")
    .command("test")
    .description("Test the X11 connection")
    .action(async () => {
      const result = await diagnoseContainerX11();
      getTerminal().stdout.write(result.output);
      setExitCode(result.exitCode);
    });

  return program;
}
