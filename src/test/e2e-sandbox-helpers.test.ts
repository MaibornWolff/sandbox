import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTomlConfig } from "#modules/configuration/index.js";
import {
  assertSandboxSuccess,
  buildTerminalCommandArgs,
  createE2eGlobalConfig,
  type SandboxResult,
  sanitizeSandboxOutput,
} from "./e2e-sandbox-helpers.js";
import { runWithTestLogger } from "./host-test-scope.js";
import { cleanupTestDir, createTestDir } from "./utils.js";

function result(overrides: Partial<SandboxResult> = {}): SandboxResult {
  return {
    command: ["sandbox", "run", "--", "failing-command"],
    stdout: "sanitized stdout",
    stderr: "sanitized stderr",
    rawStdout: "full stdout\nCreating sandbox container...\n",
    rawStderr: "full stderr\n",
    exitCode: 0,
    ...overrides,
  };
}

describe("E2E global configuration", () => {
  test("keeps template defaults and applies runtime and DNS selection", () => {
    using cleanup = new DisposableStack();
    const directory = createTestDir("e2e-config");
    cleanup.defer(() => cleanupTestDir(directory));
    const templatePath = join(directory, "template.toml");
    const configPath = join(directory, "config.toml");
    writeFileSync(
      templatePath,
      'runtime = "docker"\nenv = ["MISE_TRUSTED_CONFIG_PATHS=/"]\n[runtimes.apple-container]\ndns = "default"\n',
    );
    createE2eGlobalConfig({
      templatePath,
      configPath,
      runtime: "apple-container",
      appleDns: "host",
    });
    const config = runWithTestLogger(() => loadTomlConfig(configPath));
    expect(config?.runtime).toBe("apple-container");
    expect(config?.runtimes?.["apple-container"]?.dns).toBe("host");
    expect(config?.env).toEqual(["MISE_TRUSTED_CONFIG_PATHS=/"]);

    createE2eGlobalConfig({ templatePath, configPath });
    const defaults = runWithTestLogger(() => loadTomlConfig(configPath));
    expect(defaults?.runtime).toBe("docker");
    expect(defaults?.runtimes?.["apple-container"]?.dns).toBe("default");
  });
});

describe("sandbox result assertions", () => {
  test("accepts successful commands", () => {
    expect(() => assertSandboxSuccess(result())).not.toThrow();
  });

  test("reports the command, exit code, and full output", () => {
    expect(() => assertSandboxSuccess(result({ exitCode: 17 }))).toThrow(
      [
        "Sandbox command failed: 'sandbox' 'run' '--' 'failing-command'",
        "Exit code: 17",
        "stdout:",
        "full stdout\nCreating sandbox container...",
        "stderr:",
        "full stderr",
      ].join("\n"),
    );
  });
});

describe("sandbox output sanitization", () => {
  test("removes ignored warning blocks without leaving blank stderr", () => {
    expect(
      sanitizeSandboxOutput(
        [
          "⚠️  X11 clipboard not available",
          "   Run `sandbox setup-x11` for setup instructions",
          "   Terminal text clipboard may work via OSC 52 passthrough",
          "",
          "",
          "",
        ].join("\n"),
      ),
    ).toBe("");
    expect(sanitizeSandboxOutput("HTTP 403 Blocked\r\n\r\n403\r\n")).toBe(
      "HTTP 403 Blocked\n\n403\n",
    );
  });
});

describe("terminal command arguments", () => {
  test("uses util-linux script syntax on Linux", () => {
    expect(
      buildTerminalCommandArgs({
        scriptPath: "/usr/bin/script",
        commandArgs: ["timeout", "20", "sandbox", "run", "hello world"],
        platform: "linux",
      }),
    ).toEqual([
      "/usr/bin/script",
      "-q",
      "-e",
      "-c",
      "'timeout' '20' 'sandbox' 'run' 'hello world'",
      "/dev/null",
    ]);
  });

  test("uses BSD script syntax on macOS", () => {
    expect(
      buildTerminalCommandArgs({
        scriptPath: "/usr/bin/script",
        commandArgs: ["timeout", "20", "sandbox", "run", "hello world"],
        platform: "darwin",
      }),
    ).toEqual([
      "/bin/sh",
      "-c",
      "printf '' | '/usr/bin/script' '-q' '-e' '/dev/null' 'timeout' '20' 'sandbox' 'run' 'hello world'",
    ]);
  });

  test("rejects platforms without a supported script implementation", () => {
    expect(() =>
      buildTerminalCommandArgs({
        scriptPath: "script",
        commandArgs: ["sandbox", "run"],
        platform: "win32",
      }),
    ).toThrow("Terminal E2E tests are unsupported on win32");
  });
});
