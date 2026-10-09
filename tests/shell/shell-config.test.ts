import { afterEach, describe, expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRepoRootPath } from "#platform/git/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";

interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const testDirs: string[] = [];

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    cleanupTestDir(dir);
  }
});

async function getDockerFilePath(fileName: string): Promise<string> {
  const repoRoot = await getRepoRootPath(process.cwd());
  return path.join(repoRoot, "docker", "configs", fileName);
}

function createSandboxHome(prefix: string): string {
  const dir = createTestDir(prefix);
  testDirs.push(dir);
  return dir;
}

async function runShellCommand(
  shell: "sh" | "bash" | "zsh",
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<ShellResult> {
  const proc = Bun.spawn([shell, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

async function installFakeAutosuggestionsPlugin(
  homeDir: string,
): Promise<string> {
  const pluginPath = path.join(homeDir, "zsh-autosuggestions.zsh");
  await writeFile(
    pluginPath,
    "_zsh_autosuggest_start() { :; }\n_zsh_autosuggest_start\n",
  );
  return pluginPath;
}

async function getAutosuggestionsState(): Promise<string[]> {
  const zshrcPath = await getDockerFilePath("zshrc");
  const homeDir = createSandboxHome("sandbox-zsh-home");
  const pluginPath = await installFakeAutosuggestionsPlugin(homeDir);
  await writeFile(path.join(homeDir, ".profile"), "");

  const script = [
    `. ${JSON.stringify(zshrcPath)} >/dev/null 2>&1`,
    'print -- "$ZSH_AUTOSUGGEST_STRATEGY"',
    "if (( $+functions[_zsh_autosuggest_start] )); then print enabled; else print disabled; fi",
  ].join("; ");

  const result = await runShellCommand("zsh", ["-fic", script], {
    HOME: homeDir,
    ZSH_AUTOSUGGESTIONS_FILE: pluginPath,
  });

  expect(result.exitCode).toBe(0);
  return result.stdout.trim().split("\n");
}

async function getProfileLocalMarker(): Promise<string> {
  const profilePath = await getDockerFilePath("profile");
  const homeDir = createSandboxHome("sandbox-profile");
  await writeFile(
    path.join(homeDir, ".profile.local"),
    "export PROFILE_LOCAL_MARKER=loaded\n",
  );

  const result = await runShellCommand(
    "sh",
    [
      "-c",
      `. ${JSON.stringify(profilePath)}; printf '%s' "$PROFILE_LOCAL_MARKER"`,
    ],
    { HOME: homeDir, SANDBOX_PROFILE_LOADED: undefined },
  );

  expect(result.exitCode).toBe(0);
  return result.stdout;
}

describe("sandbox shell config", () => {
  test.each([
    ["bash", ["--noprofile", "--norc"]],
    ["zsh", ["-f"]],
  ] as const)(
    "activates Mise once when sourced by %s",
    async (shell, flags) => {
      const home = createSandboxHome("mise-activation");
      const executable = path.join(home, "mise");
      await writeFile(
        executable,
        `#!/bin/sh
printf 'export MISE_ACTIVATED=%s\\n' "$2"
printf 'called\\n' >> "$HOME/mise-calls"
`,
      );
      await chmod(executable, 0o755);
      const profile = JSON.stringify(await getDockerFilePath("profile"));
      const script = [
        `. ${profile}`,
        `. ${profile}`,
        'printf "%s\\n" "$MISE_ACTIVATED"',
        'cat "$HOME/mise-calls"',
      ].join("\n");
      const result = await runShellCommand(shell, [...flags, "-c", script], {
        HOME: home,
        ZDOTDIR: home,
        BASH_ENV: undefined,
        ENV: undefined,
        PATH: `${home}${path.delimiter}${process.env.PATH ?? ""}`,
        SANDBOX_PROFILE_LOADED: undefined,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([shell, "called"]);
    },
  );

  test("enables zsh autosuggestions when the plugin is available", async () => {
    await expect(getAutosuggestionsState()).resolves.toEqual([
      "history completion",
      "enabled",
    ]);
  });

  test("loads profile.local from the default profile", async () => {
    await expect(getProfileLocalMarker()).resolves.toBe("loaded");
  });
});
