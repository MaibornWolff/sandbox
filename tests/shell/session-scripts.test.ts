import { afterEach, describe, expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildSessionDetailsCommand,
  buildSessionIdleCommand,
} from "#platform/container-system/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";

const testDirectories: string[] = [];

afterEach(() => {
  for (const directory of testDirectories.splice(0)) {
    cleanupTestDir(directory);
  }
});

const DEAD_PID = "999999";

async function prepareSessionsDirectory(): Promise<string> {
  const directory = createTestDir("sandbox-session-scripts");
  testDirectories.push(directory);
  await Promise.all([
    writeFile(path.join(directory, String(process.pid)), ""),
    writeFile(path.join(directory, DEAD_PID), ""),
  ]);
  return directory;
}

async function runInDirectory(
  command: readonly string[],
  sessionsDirectory: string,
): Promise<{ readonly stdout: string; readonly exitCode: number }> {
  const child = Bun.spawn(
    command.map((part) =>
      part.replaceAll("/tmp/sandbox-sessions", sessionsDirectory),
    ),
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { stdout, exitCode };
}

describe("container session scripts", () => {
  test("session details list live sessions and remove stale markers", async () => {
    const sessionsDirectory = await prepareSessionsDirectory();

    const result = await runInDirectory(
      buildSessionDetailsCommand(),
      sessionsDirectory,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("|")[0]).toBe(String(process.pid));
    expect(await readdir(sessionsDirectory)).toEqual([String(process.pid)]);
  });

  test("idle check fails while a session is live and passes once markers are stale", async () => {
    const sessionsDirectory = await prepareSessionsDirectory();

    expect(
      (await runInDirectory(buildSessionIdleCommand(), sessionsDirectory))
        .exitCode,
    ).toBe(1);

    await Bun.$`rm ${path.join(sessionsDirectory, String(process.pid))}`;
    const idle = await runInDirectory(
      buildSessionIdleCommand(),
      sessionsDirectory,
    );

    expect(idle.exitCode).toBe(0);
    expect(await readdir(sessionsDirectory)).toEqual([]);
  });
});
