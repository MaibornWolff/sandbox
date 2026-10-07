import type { Command } from "commander";
import { formatErrorDiagnostics, getLogger } from "#platform/logging/index.js";
import { getTerminal, type Terminal } from "#platform/terminal/index.js";
import { getErrorMessage } from "#shared/errors/index.js";
import { createContainerToolsProgram } from "./create-program.js";

function isCommanderError(error: unknown): error is { readonly code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("commander.")
  );
}

function getErrorExitCode(error: unknown): number {
  if (
    typeof error === "object" &&
    error !== null &&
    "exitCode" in error &&
    typeof error.exitCode === "number"
  ) {
    return error.exitCode;
  }
  return 1;
}

function configureOutput(program: Command, terminal: Terminal): void {
  program.allowExcessArguments(false);
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => terminal.stdout.write(text),
    writeErr: (text) => terminal.stderr.write(text),
  });
  for (const command of program.commands) configureOutput(command, terminal);
}

export async function runContainerToolsApplication(
  argv: readonly string[],
  version: string,
): Promise<number> {
  const terminal = getTerminal();
  let exitCode = 0;
  const program = createContainerToolsProgram(version, (code) => {
    exitCode = code;
  });
  configureOutput(program, terminal);

  try {
    await program.parseAsync(argv.length === 0 ? ["--help"] : [...argv], {
      from: "user",
    });
    return exitCode;
  } catch (error) {
    if (!isCommanderError(error)) {
      getLogger().debug(formatErrorDiagnostics(error));
      terminal.stderr.write(`${getErrorMessage(error)}\n`);
    }
    return getErrorExitCode(error);
  }
}
