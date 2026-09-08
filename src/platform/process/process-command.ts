import { getLogger } from "#platform/logging/index.js";
import {
  createRedactionContext,
  redactCommandForDisplay,
} from "#shared/text/index.js";
import type { ProcessManager, ProcessResult } from "./process-manager.js";

export class ExecError extends Error {
  readonly stderr: string;
  readonly stdout: string;

  constructor(
    message: string,
    readonly exitCode: number,
    output: { readonly stderr?: string; readonly stdout?: string } = {},
  ) {
    super(message);
    this.name = "ExecError";
    this.stderr = output.stderr ?? "";
    this.stdout = output.stdout ?? "";
  }
}

interface ProcessCommandOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly interactive?: boolean;
}

interface ProcessCommandExecutor {
  execute(request: {
    readonly command: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly stdio?: "capture" | "inherit" | "ignore";
  }): Promise<ProcessResult>;
}

type ProcessCommandBoundary =
  | Pick<ProcessManager, "start">
  | ProcessCommandExecutor;

function buildCommandFailureMessage(options: {
  readonly exitCode: number;
  readonly interactive: boolean;
  readonly stderr: string;
  readonly stdout: string;
}): string {
  const output = options.interactive
    ? ""
    : [options.stderr, options.stdout].filter(Boolean).join("\n");
  return output
    ? `Command failed with exit code ${options.exitCode}: ${output}`
    : `Command failed with exit code ${options.exitCode}`;
}

export async function executeProcessCommand(
  processes: ProcessCommandBoundary,
  command: string,
  args: readonly string[] = [],
  options: ProcessCommandOptions = {},
): Promise<string> {
  const interactive = options.interactive ?? false;
  const redactionContext = createRedactionContext({
    args: [...args],
    env: options.env ? { ...options.env } : undefined,
  });
  getLogger().debug(
    `Executing: ${redactCommandForDisplay(command, [...args])}`,
  );
  const request = {
    command,
    args,
    ...(options.env ? { env: options.env } : {}),
    stdio: interactive ? ("inherit" as const) : ("capture" as const),
  };
  const result =
    "start" in processes
      ? await processes.start({
          ...request,
          lifetime: "application",
          interaction: { mode: "non-interactive" },
        }).result
      : await processes.execute(request);
  if (result.exitCode === 0) return interactive ? "" : result.stdout;

  const stderr = redactionContext.redactText(result.stderr);
  const stdout = redactionContext.redactText(result.stdout);
  throw new ExecError(
    buildCommandFailureMessage({
      exitCode: result.exitCode,
      interactive,
      stderr,
      stdout,
    }),
    result.exitCode,
    { stderr, stdout },
  );
}
