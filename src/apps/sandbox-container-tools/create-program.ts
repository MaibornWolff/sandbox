import { Argument, Command } from "commander";
import { getSandboxSettings } from "#modules/sandbox-settings/index.js";
import {
  CONTAINER_LOG_SOURCES,
  type ContainerLogSource,
  collectPassiveNetworkState,
  readContainerLog,
  readContainerLogBundle,
  serializeContainerLogBundle,
} from "#platform/container-system/index.js";
import { getTerminal } from "#platform/terminal/index.js";
import { diagnoseContainerX11 } from "#platform/x11-clipboard/index.js";
import { runClipboardProxyCommand } from "./clipboard-proxy-command.js";
import { runContainerEntrypoint } from "./entrypoint.js";

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

  program
    .command("clipboard-proxy")
    .description("Run the private clipboard session")
    .action(runClipboardProxyCommand);

  const network = program
    .command("network")
    .description("Inspect container networking");
  network
    .command("diagnostic")
    .description("Read a network diagnostic log")
    .addArgument(new Argument("<source>").choices([...CONTAINER_LOG_SOURCES]))
    .action((source: ContainerLogSource) => {
      getTerminal().stdout.write(readContainerLog(source));
    });
  network
    .command("diagnostics")
    .description("Read all network diagnostic logs as one JSON document")
    .action(() => {
      getTerminal().stdout.write(
        serializeContainerLogBundle(readContainerLogBundle()),
      );
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
