import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRepoRootPath } from "#platform/git/index.js";
import { shellQuote } from "#shared/text/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";

const testDirectories: string[] = [];
const sessionId = "a82b48cf-c10b-48ed-9fc4-193b80ef2856";

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
  readonly renameArgumentsPath: string;
  readonly renamedContentsPath: string;
  readonly sessionsDirectory: string;
}> {
  const repoRoot = await getRepoRootPath(process.cwd());
  const directory = createTestDir("sandbox-exec-entrypoint");
  testDirectories.push(directory);
  const binDirectory = path.join(directory, "bin");
  const sessionsDirectory = path.join(directory, "sessions");
  const scriptPath = path.join(directory, "exec-entrypoint.sh");
  const argumentsPath = path.join(directory, "arguments.txt");
  const renameArgumentsPath = path.join(directory, "mv-arguments.txt");
  const renamedContentsPath = path.join(directory, "mv-contents.txt");
  const realMv = Bun.which("mv");
  if (!realMv) throw new Error("The exec entrypoint test needs mv.");
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
  // Record each rename and the content of the renamed file, then rename it.
  await createExecutable(
    path.join(binDirectory, "mv"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$@" >> "$FAKE_MV_ARGUMENTS_PATH"',
      'for argument in "$@"; do',
      '  if [ -f "$argument" ]; then cat "$argument" > "$FAKE_MV_CONTENTS_PATH"; fi',
      "done",
      `exec ${shellQuote(realMv)} "$@"`,
      "",
    ].join("\n"),
  );

  return {
    scriptPath,
    binDirectory,
    argumentsPath,
    renameArgumentsPath,
    renamedContentsPath,
    sessionsDirectory,
  };
}

async function readOptionalFile(filePath: string): Promise<string> {
  return existsSync(filePath) ? readFile(filePath, "utf8") : "";
}

async function runExecEntrypoint(
  expectedExitCode: number,
  shellName: "zsh" | "bash" = "zsh",
): Promise<{
  readonly exitCode: number;
  readonly pid: number;
  readonly arguments: string[];
  readonly sessionsDirectory: string;
  readonly sessionEntries: string[];
  readonly stagingEntries: string[] | null;
  readonly markerPid: string;
  readonly markerContents: string;
  readonly renameArguments: string[];
  readonly renamedContents: string;
}> {
  const fixture = await prepareExecEntrypoint(shellName);
  const child = Bun.spawn(
    ["sh", fixture.scriptPath, "printf", "%s", "argument with spaces"],
    {
      env: {
        ...process.env,
        PATH: `${fixture.binDirectory}:${process.env.PATH ?? ""}`,
        FAKE_ARGUMENTS_PATH: fixture.argumentsPath,
        FAKE_MV_ARGUMENTS_PATH: fixture.renameArgumentsPath,
        FAKE_MV_CONTENTS_PATH: fixture.renamedContentsPath,
        FAKE_EXIT_CODE: String(expectedExitCode),
        SANDBOX_SESSION_ID: sessionId,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exitCode = await child.exited;
  const stagingDirectory = path.join(fixture.sessionsDirectory, ".staging");
  const [argumentsText, entries, renameArguments, renamedContents] =
    await Promise.all([
      readFile(fixture.argumentsPath, "utf8"),
      readdir(fixture.sessionsDirectory, { withFileTypes: true }),
      readOptionalFile(fixture.renameArgumentsPath),
      readOptionalFile(fixture.renamedContentsPath),
    ]);
  const markerPid = entries.find((entry) => entry.isFile())?.name ?? "";
  return {
    exitCode,
    pid: child.pid,
    arguments: argumentsText.trimEnd().split("\n"),
    sessionsDirectory: fixture.sessionsDirectory,
    sessionEntries: entries.map((entry) => entry.name).sort(),
    stagingEntries: existsSync(stagingDirectory)
      ? await readdir(stagingDirectory)
      : null,
    markerPid,
    markerContents: markerPid
      ? await readFile(path.join(fixture.sessionsDirectory, markerPid), "utf8")
      : "",
    renameArguments: renameArguments.split("\n").filter(Boolean),
    renamedContents,
  };
}

describe("exec-entrypoint.sh", () => {
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

  test("writes marker v2 with the session ID and the requested command", async () => {
    const result = await runExecEntrypoint(0);

    expect(result.markerPid).toMatch(/^\d+$/);
    expect(result.markerContents).toBe(
      `${sessionId}\0printf\0%s\0argument with spaces\0`,
    );
  });

  test("moves the complete marker from the staging folder in one rename", async () => {
    const result = await runExecEntrypoint(0);
    const pid = String(result.pid);

    expect(result.renameArguments).toEqual([
      "-f",
      path.join(result.sessionsDirectory, ".staging", pid),
      path.join(result.sessionsDirectory, pid),
    ]);
    expect(result.renamedContents).toBe(
      `${sessionId}\0printf\0%s\0argument with spaces\0`,
    );
    expect(result.stagingEntries).toEqual([]);
    expect(result.sessionEntries).toEqual([".staging", pid]);
  });

  test("falls back to bash when zsh is unavailable", async () => {
    const result = await runExecEntrypoint(0, "bash");

    expect(result.arguments[1]).toEndWith("/bash");
  });

  test("preserves gosu exit status", async () => {
    expect((await runExecEntrypoint(37)).exitCode).toBe(37);
  });
});
