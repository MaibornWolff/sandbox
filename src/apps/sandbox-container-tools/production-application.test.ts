import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { getTestRepoRootPath } from "#test/utils.js";
import { runProductionContainerToolsApplication } from "./production-application.js";

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
  const script = `
    import { runProductionContainerToolsApplication } from "./src/apps/sandbox-container-tools/production-application.ts";
    import { readProcessTerminalStreams } from "./src/platform/terminal/index.ts";
    process.exitCode = await runProductionContainerToolsApplication(${JSON.stringify(args)}, "7.8.9", readProcessTerminalStreams());
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

describe("production container-tools application", () => {
  test("routes direct composition output through its supplied terminal streams", async () => {
    const terminal = recordingTerminalStreams();
    expect(
      await runProductionContainerToolsApplication(
        ["--version"],
        "7.8.9",
        terminal.streams,
      ),
    ).toBe(0);
    expect(
      await runProductionContainerToolsApplication(
        ["unknown"],
        "7.8.9",
        terminal.streams,
      ),
    ).toBe(1);
    expect(terminal.stdout()).toBe("7.8.9\n");
    expect(terminal.stderr()).toBe("error: unknown command 'unknown'\n");
  });

  test("preserves process exit codes and releases production resources", async () => {
    const success = await runProductionProcess(["--version"]);
    expect(success).toEqual({
      exitCode: 0,
      stdout: "7.8.9\n",
      stderr: "",
    });

    const failure = await runProductionProcess(["unknown"]);
    expect(failure).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "error: unknown command 'unknown'\n",
    });
  });
});
