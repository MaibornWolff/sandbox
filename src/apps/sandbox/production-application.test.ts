import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { getTestRepoRootPath } from "#test/utils.js";
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
