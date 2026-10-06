import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  createNodeProcessAdapter,
  getCurrentPid,
} from "./node-process-adapter.js";

function createAdapter(platform: NodeJS.Platform = "linux") {
  return createNodeProcessAdapter({
    environment: {
      currentWorkingDirectory: "/tmp",
      variables: {},
      platform,
    },
    terminal: {
      input: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    },
  });
}

describe("Node process adapter", () => {
  test("reports the current owner process identifier", () => {
    expect(getCurrentPid()).toBe(process.pid);
  });

  test("passes shell metacharacters to commands as literal arguments", async () => {
    const argument = "value & echo unsafe | <input> %PATH%";
    const result = await createAdapter().start({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", argument],
      lifetime: "application",
      interaction: { mode: "non-interactive" },
    }).result;

    expect(result).toEqual({ exitCode: 0, stdout: argument, stderr: "" });
  });

  test("reports missing Linux and safely unsupported Windows identities", () => {
    expect(createAdapter().capture(2_147_483_647)).toEqual({
      status: "missing",
    });
    expect(createAdapter("win32").capture(1)).toEqual({
      status: "unsupported",
      reason: "Stable external process identity is unsupported on win32.",
    });
  });
});
