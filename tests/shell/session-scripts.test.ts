import { afterEach, describe, expect, test } from "bun:test";
import { readdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildSessionIdleCommand,
  buildSessionStatusCommand,
  CONTAINER_READY_FILE,
  parseSessionStatus,
} from "#platform/container-system/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";

const testDirectories: string[] = [];

afterEach(() => {
  for (const directory of testDirectories.splice(0)) {
    cleanupTestDir(directory);
  }
});

const DEAD_PID = "999999";
const LIVE_PID = String(process.pid);
const SESSION_ID = "6f1c0d3e-9a4b-4c2d-8e7f-1a2b3c4d5e6f";

interface SessionsFixture {
  readonly sessionsDirectory: string;
  readonly readyFile: string;
}

function markerV2(fields: readonly string[]): string {
  return fields.map((field) => `${field}\0`).join("");
}

async function prepareSessionsDirectory(
  liveMarker = "",
): Promise<SessionsFixture> {
  const directory = createTestDir("sandbox-session-scripts");
  testDirectories.push(directory);
  const sessionsDirectory = path.join(directory, "sessions");
  await Bun.$`mkdir -p ${sessionsDirectory}`;
  await Promise.all([
    writeFile(path.join(sessionsDirectory, LIVE_PID), liveMarker),
    writeFile(path.join(sessionsDirectory, DEAD_PID), ""),
  ]);
  return { sessionsDirectory, readyFile: path.join(directory, "ready") };
}

async function runInDirectory(
  command: readonly string[],
  fixture: SessionsFixture,
): Promise<{ readonly stdout: string; readonly exitCode: number }> {
  const child = Bun.spawn(
    command.map((part) =>
      part
        .replaceAll("/tmp/sandbox-sessions", fixture.sessionsDirectory)
        .replaceAll(CONTAINER_READY_FILE, fixture.readyFile),
    ),
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { stdout, exitCode };
}

async function probe(fixture: SessionsFixture) {
  const result = await runInDirectory(buildSessionStatusCommand(), fixture);
  expect(result.exitCode).toBe(0);
  return parseSessionStatus(result.stdout);
}

describe("container session scripts", () => {
  test("status probe reports the ready state and live sessions and keeps all markers", async () => {
    const fixture = await prepareSessionsDirectory(
      markerV2([SESSION_ID, "claude", "--resume"]),
    );
    const startedAt = new Date("2026-11-16T09:02:10.000Z");
    await utimes(
      path.join(fixture.sessionsDirectory, LIVE_PID),
      startedAt,
      startedAt,
    );

    const starting = await probe(fixture);
    await writeFile(fixture.readyFile, "");
    const ready = await probe(fixture);

    expect(starting.ready).toBe(false);
    expect(ready.ready).toBe(true);
    expect(ready.sessions).toEqual([
      {
        pid: process.pid,
        startedAt,
        id: SESSION_ID,
        command: ["claude", "--resume"],
        title: expect.any(String),
      },
    ]);
    expect((await readdir(fixture.sessionsDirectory)).sort()).toEqual(
      [DEAD_PID, LIVE_PID].sort(),
    );
  });

  test("status probe keeps an argument with a newline", async () => {
    const fixture = await prepareSessionsDirectory(
      markerV2([SESSION_ID, "claude", "first line\nsecond line"]),
    );

    const status = await probe(fixture);

    expect(status.sessions[0]?.command).toEqual([
      "claude",
      "first line\nsecond line",
    ]);
  });

  test("status probe reports no command for a marker larger than 64 KiB", async () => {
    const fixture = await prepareSessionsDirectory(
      markerV2([SESSION_ID, "claude", "x".repeat(70_000)]),
    );

    const status = await probe(fixture);

    expect(status.sessions[0]).toMatchObject({
      id: SESSION_ID,
      command: null,
    });
  });

  test("idle check fails while a session is live and passes once markers are stale", async () => {
    const fixture = await prepareSessionsDirectory();

    expect(
      (await runInDirectory(buildSessionIdleCommand(), fixture)).exitCode,
    ).toBe(1);

    await Bun.$`rm ${path.join(fixture.sessionsDirectory, LIVE_PID)}`;
    const idle = await runInDirectory(buildSessionIdleCommand(), fixture);

    expect(idle.exitCode).toBe(0);
    expect(await readdir(fixture.sessionsDirectory)).toEqual([]);
  });
});
