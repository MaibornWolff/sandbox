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

// Output of `git rev-parse --local-env-vars`. Git hooks export some of these,
// which would redirect commands away from the requested working directory.
const GIT_REPOSITORY_VARIABLES = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
]);

function releaseCommandEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !GIT_REPOSITORY_VARIABLES.has(name),
    ),
  );
  return { ...environment, HUSKY: "0" };
}

export const runReleaseCommand: ReleaseCommand = (command, args, cwd) => {
  console.error(`Running ${chalk.cyan([command, ...args].join(" "))}`);
  const result = crossSpawn.sync(command, [...args], {
    cwd,
    encoding: "utf8",
    env: releaseCommandEnvironment(),
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
