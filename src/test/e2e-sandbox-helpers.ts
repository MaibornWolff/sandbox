const IGNORED_SANDBOX_OUTPUT = [
  "X11 clipboard not available",
  "Run `sandbox setup-x11` for setup instructions",
  "Terminal text clipboard may work via OSC 52 passthrough",
  "Creating sandbox container...",
];

export interface SandboxResult {
  readonly command: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly rawStdout: string;
  readonly rawStderr: string;
  readonly exitCode: number;
}

export function sanitizeSandboxOutput(raw: string): string {
  const sanitized = raw
    .replace(/\r/g, "")
    .split("\n")
    .filter(
      (line) =>
        !IGNORED_SANDBOX_OUTPUT.some((ignored) => line.includes(ignored)),
    )
    .join("\n");
  return sanitized.trim() === "" ? "" : sanitized;
}

function formatCapturedOutput(output: string): string {
  return output === "" ? "<empty>" : output.replace(/\n$/u, "");
}

function quoteShellArgument(argument: string): string {
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

export function assertSandboxSuccess(result: SandboxResult): void {
  if (result.exitCode === 0) return;
  throw new Error(
    [
      `Sandbox command failed: ${result.command.map(quoteShellArgument).join(" ")}`,
      `Exit code: ${result.exitCode}`,
      "stdout:",
      formatCapturedOutput(result.rawStdout),
      "stderr:",
      formatCapturedOutput(result.rawStderr),
    ].join("\n"),
  );
}

export function buildTerminalCommandArgs(options: {
  readonly scriptPath: string;
  readonly commandArgs: readonly string[];
  readonly platform: NodeJS.Platform;
}): string[] {
  if (options.platform === "darwin") {
    const scriptArgs = [
      options.scriptPath,
      "-q",
      "-e",
      "/dev/null",
      ...options.commandArgs,
    ];
    return [
      "/bin/sh",
      "-c",
      `printf '' | ${scriptArgs.map(quoteShellArgument).join(" ")}`,
    ];
  }
  if (options.platform === "linux") {
    return [
      options.scriptPath,
      "-q",
      "-e",
      "-c",
      options.commandArgs.map(quoteShellArgument).join(" "),
      "/dev/null",
    ];
  }
  throw new Error(`Terminal E2E tests are unsupported on ${options.platform}`);
}
