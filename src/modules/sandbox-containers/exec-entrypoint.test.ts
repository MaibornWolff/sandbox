import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRepoRootPath } from "#platform/git/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";

const testDirectories: string[] = [];

afterEach(() => {
  for (const directory of testDirectories.splice(0)) {
    cleanupTestDir(directory);
  }
});

async function createExecutable(
  filePath: string,
  content: string,
): Promise<void> {
  await writeFile(filePath, content);
  await chmod(filePath, 0o755);
}

async function prepareExecEntrypoint(
  shellName: "zsh" | "bash" = "zsh",
): Promise<{
  readonly scriptPath: string;
  readonly binDirectory: string;
  readonly argumentsPath: string;
  readonly sessionsDirectory: string;
}> {
  const repoRoot = await getRepoRootPath(process.cwd());
  const directory = createTestDir("sandbox-exec-entrypoint");
  testDirectories.push(directory);
  const binDirectory = path.join(directory, "bin");
  const sessionsDirectory = path.join(directory, "sessions");
  const scriptPath = path.join(directory, "exec-entrypoint.sh");
  const argumentsPath = path.join(directory, "arguments.txt");
  await Promise.all([
    mkdir(binDirectory, { recursive: true }),
    mkdir(sessionsDirectory, { recursive: true }),
  ]);

  const source = await readFile(
    path.join(repoRoot, "docker", "scripts", "exec-entrypoint.sh"),
    "utf8",
  );
  const fixtureSource = source
    .replaceAll("/tmp/sandbox-sessions", sessionsDirectory)
    .replaceAll(
      "command -v zsh",
      shellName === "zsh" ? "command -v zsh" : "false",
    );
  await writeFile(scriptPath, fixtureSource);
  await createExecutable(
    path.join(binDirectory, shellName),
    "#!/bin/sh\nexit 99\n",
  );
  await createExecutable(
    path.join(binDirectory, "gosu"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "$FAKE_ARGUMENTS_PATH"',
      'exit "$FAKE_EXIT_CODE"',
      "",
    ].join("\n"),
  );

  return { scriptPath, binDirectory, argumentsPath, sessionsDirectory };
}

async function runExecEntrypoint(
  expectedExitCode: number,
  shellName: "zsh" | "bash" = "zsh",
): Promise<{
  readonly exitCode: number;
  readonly arguments: string[];
  readonly markerPid: string;
}> {
  const fixture = await prepareExecEntrypoint(shellName);
  const child = Bun.spawn(
    ["sh", fixture.scriptPath, "printf", "%s", "argument with spaces"],
    {
      env: {
        ...process.env,
        PATH: `${fixture.binDirectory}:${process.env.PATH ?? ""}`,
        FAKE_ARGUMENTS_PATH: fixture.argumentsPath,
        FAKE_EXIT_CODE: String(expectedExitCode),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exitCode = await child.exited;
  const [argumentsText, markers] = await Promise.all([
    readFile(fixture.argumentsPath, "utf8"),
    readdir(fixture.sessionsDirectory),
  ]);
  return {
    exitCode,
    arguments: argumentsText.trimEnd().split("\n"),
    markerPid: markers[0] ?? "",
  };
}

describe.skipIf(process.platform === "win32")("exec-entrypoint.sh", () => {
  test("loads the login shell and forwards exact command arguments through gosu", async () => {
    const result = await runExecEntrypoint(0);

    expect(result.markerPid).toMatch(/^\d+$/);
    expect(result.arguments[0]).toBe("sandbox");
    expect(result.arguments[1]).toEndWith("/zsh");
    expect(result.arguments.slice(2)).toEqual([
      "-lc",
      'exec "$@"',
      "sandbox-exec",
      "printf",
      "%s",
      "argument with spaces",
    ]);
  });

  test("falls back to bash when zsh is unavailable", async () => {
    const result = await runExecEntrypoint(0, "bash");

    expect(result.arguments[1]).toEndWith("/bash");
  });

  test("preserves gosu exit status", async () => {
    expect((await runExecEntrypoint(37)).exitCode).toBe(37);
  });
});
