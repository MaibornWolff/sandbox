import { afterEach, describe, expect, test } from "bun:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRepoRootPath } from "#platform/git/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";

interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const testDirectories: string[] = [];

afterEach(() => {
  for (const directory of testDirectories.splice(0)) {
    cleanupTestDir(directory);
  }
});

async function runScript(
  scriptPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  const process = Bun.spawn(["sh", scriptPath, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function prepareNodeWrapper(
  sourceName: "sandbox-container-tools" | "sandbox-wrapper.sh",
): Promise<{
  readonly directory: string;
  readonly wrapperPath: string;
  readonly entryPath: string;
  readonly argumentsPath: string;
}> {
  const repoRoot = await getRepoRootPath(process.cwd());
  const directory = createTestDir(`sandbox-${sourceName}`);
  testDirectories.push(directory);
  const sourcePath = path.join(repoRoot, "docker", "scripts", sourceName);
  const wrapperPath = path.join(directory, sourceName);
  const entryPath = path.join(directory, "main.js");
  const nodePath = path.join(directory, "node");
  const argumentsPath = path.join(directory, "arguments.txt");
  const imageEntry =
    sourceName === "sandbox-container-tools"
      ? "/opt/sandbox-cli/dist/apps/sandbox-container-tools/main.js"
      : "/opt/sandbox-cli/dist/apps/sandbox/main.js";
  const wrapper = (await readFile(sourcePath, "utf8"))
    .replace(imageEntry, entryPath)
    .replace("/usr/bin/node", nodePath);

  await Promise.all([
    writeFile(wrapperPath, wrapper),
    writeFile(
      nodePath,
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_ARGUMENTS_PATH"\nexit "$FAKE_EXIT_CODE"\n',
    ),
  ]);
  await chmod(nodePath, 0o755);
  return { directory, wrapperPath, entryPath, argumentsPath };
}

const wrappers = ["sandbox-container-tools", "sandbox-wrapper.sh"] as const;

describe.skipIf(process.platform === "win32")("container Node wrappers", () => {
  for (const wrapperName of wrappers) {
    test(`${wrapperName} reports an incomplete image`, async () => {
      const fixture = await prepareNodeWrapper(wrapperName);

      const result = await runScript(fixture.wrapperPath, [], process.env);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not available");
    });

    test(`${wrapperName} forwards arguments and child exit status`, async () => {
      const fixture = await prepareNodeWrapper(wrapperName);
      await writeFile(fixture.entryPath, "// bundle fixture\n");

      const result = await runScript(
        fixture.wrapperPath,
        ["--version", "argument with spaces"],
        {
          ...process.env,
          FAKE_ARGUMENTS_PATH: fixture.argumentsPath,
          FAKE_EXIT_CODE: "23",
        },
      );

      expect(result.exitCode).toBe(23);
      expect(
        (await readFile(fixture.argumentsPath, "utf8")).split("\n"),
      ).toEqual([fixture.entryPath, "--version", "argument with spaces", ""]);
    });
  }
});
