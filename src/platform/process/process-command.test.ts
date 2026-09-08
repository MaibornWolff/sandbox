import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { createSystemClock } from "#platform/clock/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { createNodeProcessManager } from "./node-process-manager.js";
import { ExecError, executeProcessCommand } from "./process-command.js";

interface CommandFixture {
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly execute: (
    command: string,
    args?: readonly string[],
    options?: NonNullable<Parameters<typeof executeProcessCommand>[3]>,
  ) => Promise<string>;
}

function createCommandFixture(): CommandFixture {
  const input = new PassThrough();
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
  const processes = createNodeProcessManager({
    environment: {
      currentWorkingDirectory: process.cwd(),
      variables: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    },
    terminal: { input, stdout, stderr },
    clock: createSystemClock(),
  });
  return {
    stdout: () => stdoutText,
    stderr: () => stderrText,
    execute: (command, args = [], options = {}) =>
      runWithTestLogger(() =>
        executeProcessCommand(processes, command, args, options),
      ),
  };
}

function execCommand(
  command: string,
  args: readonly string[] = [],
  options: NonNullable<Parameters<typeof executeProcessCommand>[3]> = {},
): Promise<string> {
  return createCommandFixture().execute(command, args, options);
}

describe("executeProcessCommand", () => {
  describe("non-interactive (returns stdout)", () => {
    it("executes command with arguments", async () => {
      const output = await execCommand("node", ["-e", "console.log('hello')"]);
      expect(output.trim()).toBe("hello");
    });

    it("passes custom environment variables", async () => {
      const output = await execCommand(
        "node",
        ["-e", "console.log(process.env.TEST_VAR)"],
        { env: { TEST_VAR: "test-value" } },
      );
      expect(output.trim()).toBe("test-value");
    });

    it("rejects on non-zero exit code", async () => {
      await expect(
        execCommand("node", ["-e", "process.exit(42)"]),
      ).rejects.toThrow("exit code 42");
    });

    it("preserves exit code on ExecError", async () => {
      try {
        await execCommand("node", ["-e", "process.exit(42)"]);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ExecError);
        expect((err as ExecError).exitCode).toBe(42);
      }
    });

    it("preserves distinct exit codes", async () => {
      for (const code of [2, 42, 127]) {
        try {
          await execCommand("node", ["-e", `process.exit(${code})`]);
          expect.unreachable("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(ExecError);
          expect((err as ExecError).exitCode).toBe(code);
        }
      }
    });

    it("rejects on spawn error", async () => {
      await expect(
        execCommand("nonexistent-command-xyz", ["arg"]),
      ).rejects.toThrow();
    });

    it("redacts known secret values from stderr in ExecError", async () => {
      try {
        await execCommand("node", [
          "-e",
          "process.stderr.write('authentication failed for ghp_secret'); process.exit(1);",
          "--",
          "--build-arg",
          "GITHUB_TOKEN=ghp_secret",
        ]);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ExecError);
        const execError = err as ExecError;
        expect(execError.message).toContain(
          "authentication failed for <redacted>",
        );
        expect(execError.stderr).toBe("authentication failed for <redacted>");
        expect(execError.stdout).toBe("");
      }
    });

    it("redacts known secret values from env in stdout and message", async () => {
      try {
        await execCommand(
          "node",
          [
            "-e",
            "process.stdout.write(`token $" +
              "{process.env.API_KEY}`); process.exit(1);",
          ],
          { env: { API_KEY: "sk-secret" } },
        );
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ExecError);
        const execError = err as ExecError;
        expect(execError.message).toContain("token <redacted>");
        expect(execError.stdout).toBe("token <redacted>");
        expect(execError.stderr).toBe("");
      }
    });

    it("preserves non-secret output", async () => {
      try {
        await execCommand("node", [
          "-e",
          "process.stderr.write('plain failure'); process.exit(1);",
        ]);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ExecError);
        const execError = err as ExecError;
        expect(execError.message).toContain("plain failure");
        expect(execError.stderr).toBe("plain failure");
      }
    });
  });

  describe("interactive (stdio inherit)", () => {
    it("executes command successfully and returns empty string", async () => {
      const output = await execCommand(
        process.execPath,
        ["-e", "process.exit(0)"],
        { interactive: true },
      );
      expect(output).toBe("");
    });

    it("rejects on non-zero exit code", async () => {
      await expect(
        execCommand("node", ["-e", "process.exit(42)"], { interactive: true }),
      ).rejects.toThrow("exit code 42");
    });

    it("routes inherited stderr once through the scoped terminal", async () => {
      const fixture = createCommandFixture();
      try {
        await fixture.execute(
          "node",
          [
            "-e",
            "process.stderr.write('[sandbox-test] simulated stderr output'); process.exit(1);",
          ],
          { interactive: true },
        );
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ExecError);
        expect((err as ExecError).message).toBe(
          "Command failed with exit code 1",
        );
        expect(fixture.stderr()).toBe("[sandbox-test] simulated stderr output");
        expect(fixture.stdout()).toBe("");
      }
    });

    it("routes inherited stdout once through the scoped terminal", async () => {
      const fixture = createCommandFixture();
      try {
        await fixture.execute(
          "node",
          [
            "-e",
            "process.stdout.write('[sandbox-test] simulated stdout output'); process.exit(1);",
          ],
          { interactive: true },
        );
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ExecError);
        expect((err as ExecError).message).toBe(
          "Command failed with exit code 1",
        );
        expect(fixture.stdout()).toBe("[sandbox-test] simulated stdout output");
        expect(fixture.stderr()).toBe("");
      }
    });
  });
});
