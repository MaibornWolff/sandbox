import type { Command } from "commander";
import { runHostCommandEscape } from "#modules/host-command-escape/index.js";

export function registerEscapeCommand(program: Command): void {
  program
    .command("escape")
    .description("Run an allowed command on the host")
    .option("--list", "List allowed host command patterns")
    .argument("[command...]", "Host command and arguments")
    .addHelpText(
      "after",
      `
Examples:
  $ sandbox escape --list
  $ sandbox escape -- open report.html
  $ sandbox escape -- bun run test:e2e
`,
    )
    .action(
      async (
        command: string[],
        options: { readonly list?: boolean },
        cmd: Command,
      ) => {
        if (options.list === true) {
          if (command.length > 0) {
            cmd.error("error: --list cannot be combined with a command");
          }
          await runHostCommandEscape({ operation: "list" });
          return;
        }
        if (command.length === 0) {
          cmd.error("error: missing host command after '--'");
        }
        await runHostCommandEscape({ operation: "execute", argv: command });
      },
    );
}
