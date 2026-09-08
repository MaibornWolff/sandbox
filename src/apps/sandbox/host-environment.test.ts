import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createHostEnvironment,
  provideHostEnvironment,
} from "#platform/environment/index.js";
import {
  createProcessTerminal,
  provideTerminal,
} from "#platform/terminal/index.js";
import { stripAnsi } from "#test/utils.js";
import {
  displaySandboxInfo,
  isInsideSandbox,
  requireHost,
} from "./host-environment.js";

class RecordingStream extends Writable {
  private text = "";

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.text += chunk.toString();
    callback();
  }

  output(): string {
    return this.text;
  }
}

function withHost<T>(
  variables: Readonly<Record<string, string>>,
  callback: (output: { stdout: RecordingStream; stderr: RecordingStream }) => T,
): T {
  const stdout = new RecordingStream();
  const stderr = new RecordingStream();
  const controller = new AbortController();
  return runWithDependencies(
    [
      provideHostEnvironment(
        createHostEnvironment({
          currentWorkingDirectory: "/project",
          homeDirectory: "/home/tester",
          variables,
          platform: "linux",
          interactive: false,
        }),
      ),
      provideTerminal(
        createProcessTerminal({
          signal: controller.signal,
          streams: { input: new PassThrough(), stdout, stderr },
        }),
      ),
    ],
    () => callback({ stdout, stderr }),
  );
}

describe("host environment", () => {
  test("detects whether the scoped application is inside a sandbox", () => {
    expect(withHost({ SANDBOX: "1" }, () => isInsideSandbox())).toBe(true);
    expect(withHost({}, () => isInsideSandbox())).toBe(false);
    expect(withHost({ SANDBOX: "0" }, () => isInsideSandbox())).toBe(false);
  });

  test("reports and rejects host-only commands inside a sandbox", () => {
    withHost({ SANDBOX: "1" }, ({ stderr }) => {
      expect(() => requireHost("build")).toThrow("sandbox build is host-only");
      expect(stripAnsi(stderr.output())).toContain(
        "sandbox build is only available on the host",
      );
    });
  });

  test("allows host-only commands outside a sandbox", () => {
    expect(() => withHost({}, () => requireHost("build"))).not.toThrow();
  });

  test("renders sandbox information through scoped output", () => {
    withHost({ SANDBOX: "1" }, ({ stdout }) => {
      displaySandboxInfo();
      expect(stdout.output()).toContain("Sandbox");
      expect(stdout.output()).toContain("sandbox config schema");
      expect(stdout.output()).toContain("sandbox escape --list");
      expect(stdout.output()).toContain("sandbox escape -- <command>");
      expect(stdout.output()).toContain("/opt/sandbox-cli/docs/");
      expect(stdout.output()).toContain("sandbox assist");
    });
  });
});
