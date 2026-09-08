import type { Command } from "commander";
import {
  formatErrorAssistHint,
  shouldShowErrorAssistHint,
} from "#modules/assistance/index.js";
import {
  createConfigurationService,
  provideConfigurationService,
} from "#modules/configuration/index.js";
import { getClock } from "#platform/clock/index.js";
import { getRuntimeProvider } from "#platform/container-runtime/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { formatErrorDiagnostics, getLogger } from "#platform/logging/index.js";
import { getProcessManager } from "#platform/process/index.js";
import { getTerminal, type Terminal } from "#platform/terminal/index.js";
import { getErrorExitCode } from "#shared/errors/index.js";
import { createProgram } from "./create-program.js";

interface SandboxApplication {
  run(argv: readonly string[]): Promise<number>;
}

function isCommanderError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("commander.")
  );
}

function isReportedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "reported" in error &&
    error.reported === true
  );
}

function configureOutput(program: Command, terminal: Terminal): void {
  const output = {
    writeOut: (text: string) => terminal.stdout.write(text),
    writeErr: (text: string) => terminal.stderr.write(text),
  };
  function configureCommand(command: Command): void {
    command.exitOverride();
    command.configureOutput(output);
    for (const child of command.commands) configureCommand(child);
  }
  configureCommand(program);
}

function reportError(
  error: unknown,
  argv: readonly string[],
  terminal: Terminal,
): void {
  if (isCommanderError(error) || isReportedError(error)) return;

  const message = error instanceof Error ? error.message : String(error);
  getLogger().debug(formatErrorDiagnostics(error));
  terminal.stderr.write(
    `${message.includes("\n") ? message : `Error: ${message}`}\n`,
  );
  if (shouldShowErrorAssistHint([...argv])) {
    terminal.stderr.write(`\n${formatErrorAssistHint()}\n`);
  }
}

async function runProgram(
  argv: readonly string[],
  terminal: Terminal,
): Promise<number> {
  const program = createProgram();
  configureOutput(program, terminal);
  try {
    await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (error) {
    reportError(error, argv, terminal);
    return getErrorExitCode(error);
  }
}

export function createSandboxApplication(): SandboxApplication {
  getHostEnvironment();
  getClock();
  getProcessManager();
  getLogger();
  getRuntimeProvider();
  const terminal = getTerminal();
  const configuration = createConfigurationService();

  return {
    run(argv) {
      return runWithDependencies(
        [provideConfigurationService(configuration)],
        () => runProgram(argv, terminal),
      );
    },
  };
}
