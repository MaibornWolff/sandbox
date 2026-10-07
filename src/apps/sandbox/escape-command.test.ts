import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { parse } from "node:path";
import { createHostBridgeService } from "#modules/host-bridge/index.js";
import {
  type CommandPattern,
  createHostCommandCapability,
} from "#modules/host-command-escape/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { createNodeWebSocketService } from "#platform/websocket/index.js";
import { windowsPathToDocker } from "#shared/text/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { setupSandboxAppTest } from "./__test__/sandbox-app-test.js";

async function createBroker(patterns: readonly CommandPattern[]) {
  const processes = createProcessTestHarness();
  return runWithTestLogger(() =>
    processes.run(async () => {
      const root = parse(tmpdir()).root;
      const capability = await createHostCommandCapability({
        commandRules: [...patterns],
        hostProjectRoot: root,
        containerProjectRoot: windowsPathToDocker(root),
      });
      const session = await createHostBridgeService(
        createNodeWebSocketService(),
      ).startSession({
        containerHostName: "127.0.0.1",
        capabilities: [capability],
      });
      return {
        processes,
        variables: { ...session.clientEnvironment, SANDBOX: "1" },
        async [Symbol.asyncDispose]() {
          await session[Symbol.asyncDispose]();
          await capability[Symbol.asyncDispose]();
          await processes.dispose();
        },
      };
    }),
  );
}

describe("sandbox escape", () => {
  test("lists effective patterns without a heading", async () => {
    await using broker = await createBroker([
      ["open", { repeat: { regex: ".+" }, min: 1, max: 10 }],
      ["bun", "run", "test:e2e"],
    ]);
    await using app = await setupSandboxAppTest({
      variables: broker.variables,
    });
    expect(await app.cli.run("escape", "--list")).toEqual({
      exitCode: 0,
      stdout:
        '["open",{"repeat":{"regex":".+"},"min":1,"max":10}]\n["bun","run","test:e2e"]\n',
      stderr: "",
    });
  });

  test("prints no output for an empty effective policy", async () => {
    await using broker = await createBroker([]);
    await using app = await setupSandboxAppTest({
      variables: broker.variables,
    });
    expect(await app.cli.run("escape", "--list")).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  test("preserves each argument after the separator and returns the child exit code", async () => {
    await using broker = await createBroker([
      ["tool", "--flag", "two words", "NAME=value"],
    ]);
    await using app = await setupSandboxAppTest({
      variables: broker.variables,
    });
    const child = broker.processes.expectStart({
      match: { command: "tool", stdio: "stream" },
    });
    const execution = app.cli.run(
      "escape",
      "--",
      "tool",
      "--flag",
      "two words",
      "NAME=value",
    );
    const request = await child.waitForStart();
    expect(request.args).toEqual(["--flag", "two words", "NAME=value"]);
    expect(request.cwd).toBe(app.project.root);
    child.exit({ exitCode: 23 });
    const result = await execution;
    expect(result.exitCode).toBe(23);
    expect(result.stderr).toBe("");
  });

  test("rejects missing commands, invalid list combinations, and host use", async () => {
    await using app = await setupSandboxAppTest();
    const missing = await app.cli.run("escape");
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("missing host command after '--'");
    const combined = await app.cli.run("escape", "--list", "tool");
    expect(combined.exitCode).toBe(1);
    expect(combined.stderr).toContain(
      "--list cannot be combined with a command",
    );
    const host = await app.cli.run("escape", "--", "tool");
    expect(host.exitCode).toBe(1);
    expect(host.stderr).toBe(
      "sandbox escape: no active host command escape broker\n",
    );
    await using containerWithoutSession = await setupSandboxAppTest({
      variables: { SANDBOX: "1" },
    });
    const container = await containerWithoutSession.cli.run(
      "escape",
      "--",
      "tool",
    );
    expect(container.exitCode).toBe(1);
    expect(container.stderr).toBe(
      "sandbox escape: no active host command escape broker\n",
    );
  });
});
