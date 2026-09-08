import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { setupSandboxAppTest } from "./sandbox-app-test.js";

describe("sandbox application test harness", () => {
  test("owns readable home and data files inside its isolated workspace", async () => {
    await using app = await setupSandboxAppTest();
    app.workspace.writeHomeFile(".agent/settings.json", '{"theme":"dark"}');
    app.workspace.writeRootFile("data/sandbox/state.json", '{"version":1}');

    expect(app.workspace.readHomeFile(".agent/settings.json")).toBe(
      '{"theme":"dark"}',
    );
    expect(app.workspace.dataFileExists("sandbox/state.json")).toBe(true);
    expect(app.workspace.readDataFile("sandbox/state.json")).toBe(
      '{"version":1}',
    );
  });

  test("rejects concurrent terminal use and waits for active work before cleanup", async () => {
    const app = await setupSandboxAppTest();
    const root = app.workspace.root;
    const controller = app.processes.expectStart({
      match: { stdio: "inherit" },
    });
    const execution = app.cli.run("run", "node");
    await controller.waitForStart();

    expect(() => app.cli.run("--version")).toThrow(
      "Only one CLI execution may use an application terminal at a time",
    );

    app.editor.cancel();
    expect(
      app.processes.requests.find((request) => request.stdio === "inherit")
        ?.signal?.aborted,
    ).toBe(true);

    const cleanup = app[Symbol.asyncDispose]();
    await Promise.resolve();
    expect(fs.existsSync(root)).toBe(true);

    controller.exit();
    await execution;
    await cleanup;
    expect(fs.existsSync(root)).toBe(false);
  });
});
