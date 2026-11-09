import * as path from "node:path";

export interface HardenedHostCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Git options that stop the repository under the container-writable project
 * directory from running its own commands on the host. `core.hooksPath`
 * points below the platform null device so no hook file can exist there.
 */
function gitHardeningArgs(platform: NodeJS.Platform): readonly string[] {
  const nullDevice = platform === "win32" ? "NUL" : "/dev/null";
  return ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${nullDevice}`];
}

function isGitCommand(command: string): boolean {
  const name = path.basename(command).toLowerCase();
  return name === "git" || name === "git.exe";
}

/**
 * Apply the spawn hardening for allowlisted host commands: never resolve the
 * executable from the (container-writable) working directory on Windows, and
 * disable repository-controlled git hooks and file system monitor commands.
 */
export function hardenHostCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): HardenedHostCommand {
  const command = argv[0] ?? "";
  const args = argv.slice(1);
  return {
    command,
    args: isGitCommand(command)
      ? [...gitHardeningArgs(platform), ...args]
      : args,
    env: { ...env, NoDefaultCurrentDirectoryInExePath: "1" },
  };
}
