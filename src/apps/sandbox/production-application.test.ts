import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { getTestRepoRootPath } from "#test/utils.js";
import { createUpdateWorkerFixture } from "./__test__/update-worker.js";
import { runProductionSandboxApplication } from "./production-application.js";

function recordingTerminalStreams() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutText = "";
  let stderrText = "";
  stdout.on("data", (chunk: Buffer) => {
    stdoutText += chunk.toString();
  });
  stderr.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString();
  });
  return {
    streams: { input: new PassThrough(), stdout, stderr },
    stdout: () => stdoutText,
    stderr: () => stderrText,
  };
}

async function runProductionProcess(args: readonly string[]): Promise<{
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const cwd = await getTestRepoRootPath();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["run", "src/apps/sandbox/main.ts", ...args],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

describe("production sandbox application", () => {
  test("exits while a detached registry refresh is pending and shows it only next time", async () => {
    await using fixture = await createUpdateWorkerFixture();
    const invocations = Array.from({ length: 4 }, () => fixture.run());
    const first = await Promise.all(invocations);
    expect(first.every((result) => result.exitCode === 1)).toBe(true);
    expect(
      first.every(
        (result) => !result.stderr.includes("Sandbox update available"),
      ),
    ).toBe(true);
    await fixture.waitForRequest();
    expect(fixture.requests()).toBe(1);
    expect(fixture.cache()).toEqual({});
    fixture.writeState({
      sandboxStorage: { project: { id: "concurrent-write" } },
    });
    fixture.release();
    await fixture.waitForCache();
    expect(fixture.cache().latestVersion).toBe("2.0.0");
    expect(fixture.readState()).toEqual({
      sandboxStorage: { project: { id: "concurrent-write" } },
    });
    const next = await fixture.run();
    expect(next.stderr).toContain("Sandbox update available");
    expect(next.stderr).toContain("2.0.0");
    expect(fixture.requests()).toBe(1);
  }, 20_000);

  test("settles pending parents and the detached worker before fixture cleanup", async () => {
    await using fixture = await createUpdateWorkerFixture();
    const parent = fixture.run();
    await fixture.waitForRequest();
    await fixture[Symbol.asyncDispose]();
    expect((await parent).exitCode).toBe(1);
    expect(fixture.workerStarts()).toHaveLength(1);
    expect(fixture.workerExits()).toEqual(fixture.workerStarts());
  }, 20_000);

  test("stores detached registry errors and suppresses repeat attempts", async () => {
    await using fixture = await createUpdateWorkerFixture(403);
    const first = await fixture.run([]);
    expect(first.exitCode).toBe(1);
    await fixture.waitForRequest();
    fixture.release();
    await fixture.waitForCache();
    expect(fixture.cache().error).toContain("Failed to check for updates");
    const next = await fixture.run(["--verbose", "run", "ls"]);
    expect(next.stderr).toContain("Previous Sandbox update check failed");
    expect(fixture.requests()).toBe(1);
  }, 20_000);

  test("routes direct composition output through its supplied terminal streams", async () => {
    const terminal = recordingTerminalStreams();
    expect(
      await runProductionSandboxApplication(["--version"], terminal.streams),
    ).toBe(0);
    expect(terminal.stdout()).toBe("0.0.0-development\n");
    expect(terminal.stderr()).toBe("");
  });

  test("preserves process exit codes and releases production resources", async () => {
    const success = await runProductionProcess(["--version"]);
    expect(success.exitCode).toBe(0);
    expect(success.stdout).toContain("0.0.0-development");
    expect(success.stderr).toBe("");

    const failure = await runProductionProcess(["unknown-command"]);
    expect(failure.exitCode).toBe(1);
    expect(failure.stderr).toContain("unknown command 'unknown-command'");
  });
});
