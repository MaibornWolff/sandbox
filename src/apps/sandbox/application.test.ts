import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSystemClock, provideClock } from "#platform/clock/index.js";
import {
  provideRuntimeProvider,
  type SandboxRuntimeProvider,
} from "#platform/container-runtime/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createHostEnvironment,
  provideHostEnvironment,
} from "#platform/environment/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { provideProcessManager } from "#platform/process/index.js";
import { createTestTerminal } from "#platform/terminal/__test__/index.js";
import { provideTerminal } from "#platform/terminal/index.js";
import { createSandboxApplication } from "./application.js";

async function runWithRuntimeFailure(
  error: unknown,
  options: { readonly verbose?: boolean } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-app-error-"));
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  const terminal = createTestTerminal();
  const provider: SandboxRuntimeProvider = {
    async resolve() {
      throw error;
    },
  };
  const clock = createSystemClock();
  const processes = createProcessTestHarness();
  const logger = createLogger(
    clock,
    (message) => terminal.io.stderr.write(`${message}\n`),
    { verbose: options.verbose },
  );

  try {
    const exitCode = await runWithDependencies(
      [
        provideHostEnvironment(
          createHostEnvironment({
            currentWorkingDirectory: projectRoot,
            homeDirectory: path.join(root, "home"),
            variables: { SANDBOX_CONFIG_DIR: path.join(root, "config") },
            platform: "linux",
            interactive: false,
          }),
        ),
        provideTerminal(terminal.io),
        provideClock(clock),
        provideProcessManager(processes.manager),
        provideLogger(logger),
        provideRuntimeProvider(provider),
      ],
      () => createSandboxApplication().run(["network", "allow"]),
    );
    return {
      exitCode,
      stdout: terminal.stdout(),
      stderr: terminal.stderr(),
    };
  } finally {
    await terminal.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("sandbox application error boundary", () => {
  test("prefixes single-line failures and includes the assist hint", async () => {
    const result = await runWithRuntimeFailure(new Error("runtime failed"));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: runtime failed\n");
    expect(result.stderr).toContain("sandbox assist");
  });

  test("keeps normal errors concise and prints recursive diagnostics in verbose mode", async () => {
    const cause = new Error("runtime socket failed");
    const error = new Error("runtime failed", { cause });

    const normal = await runWithRuntimeFailure(error);
    const verbose = await runWithRuntimeFailure(error, { verbose: true });

    expect(normal.stderr).toContain("Error: runtime failed\n");
    expect(normal.stderr).not.toContain(error.stack as string);
    expect(normal.stdout).not.toContain(error.stack as string);
    expect(verbose.stderr).toContain(error.stack as string);
    expect(verbose.stderr).toContain(cause.stack as string);
  });

  test("preserves multiline formatting and child exit codes", async () => {
    const error = Object.assign(
      new Error("Setup required:\n  install runtime"),
      {
        exitCode: 42,
      },
    );

    const result = await runWithRuntimeFailure(error);

    expect(result.exitCode).toBe(42);
    expect(result.stderr).toContain("Setup required:\n  install runtime\n");
    expect(result.stderr).not.toContain("Error: Setup required");
  });
});
