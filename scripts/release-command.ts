import chalk from "chalk";
import crossSpawn from "cross-spawn";

export interface ReleaseCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ReleaseCommand = (
  command: string,
  args: readonly string[],
  cwd: string,
) => ReleaseCommandResult;

export class ReleaseCommandError extends Error {
  constructor(
    readonly exitCode: number,
    command: string,
    result: ReleaseCommandResult,
  ) {
    super(
      `${command} failed with exit code ${exitCode}: ${result.stderr || result.stdout}`,
    );
  }
}

export const runReleaseCommand: ReleaseCommand = (command, args, cwd) => {
  console.error(`Running ${chalk.cyan([command, ...args].join(" "))}`);
  const result = crossSpawn.sync(command, [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HUSKY: "0" },
  });
  if (result.error) throw result.error;
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

export function requireCommandSuccess(
  command: string,
  result: ReleaseCommandResult,
): string {
  if (result.exitCode !== 0) {
    throw new ReleaseCommandError(result.exitCode, command, result);
  }
  return result.stdout.trim();
}

export function gitCommand(args: readonly string[], cwd: string): string {
  return requireCommandSuccess("git", runReleaseCommand("git", args, cwd));
}
