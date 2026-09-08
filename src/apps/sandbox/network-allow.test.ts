import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setupSandboxAppTest } from "./__test__/sandbox-app-test.js";

describe("sandbox network allow", () => {
  test("adds a blocked domain to project config through keyboard input", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const container = app.project.givenContainer({ state: "running" });
    container.network.block("api.example.com", 443);

    const execution = app.cli.run("network", "allow");
    await app.tui.waitForText("Select domains to allow:");
    expect(app.tui.screen()).toContain("api.example.com:443");
    await app.tui.user.type("/api.example.com");
    await app.tui.user.enter();
    await app.tui.user.space();
    await app.tui.user.enter();
    await app.tui.waitForText("Add to which config?");
    await app.tui.user.down();
    await app.tui.user.enter();

    expect(await execution).toMatchObject({ exitCode: 0, stderr: "" });
    expect((await app.project.readConfig()).allowNetwork).toEqual([
      { host: "api.example.com", ports: [443], wildcard: false },
    ]);
  });

  test("adds a blocked domain to global config and leaves project config unchanged", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    app.project
      .givenContainer({ state: "running" })
      .network.block("global.example.com", 443);

    const execution = app.cli.run("network", "allow");
    await app.tui.waitForText("Select domains to allow:");
    await app.tui.user.space();
    await app.tui.user.enter();
    await app.tui.waitForText("Add to which config?");
    await app.tui.user.enter();

    expect(await execution).toMatchObject({ exitCode: 0, stderr: "" });
    expect((await app.global.readConfig()).allowNetwork).toEqual([
      { host: "global.example.com", ports: [443], wildcard: false },
    ]);
    expect((await app.project.readConfig()).allowNetwork).toEqual([]);
  });

  test("reports no blocked requests from a running container without prompting", async () => {
    await using app = await setupSandboxAppTest();
    app.project.givenContainer({ state: "running" });

    const result = await app.cli.run("network", "allow");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("No blocked network requests found.");
    expect(result.stderr).not.toContain("Restart the sandbox");
    expect(app.tui.output()).not.toContain("Select domains to allow:");
  });

  test("reports that covered domains require a sandbox restart", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({
      allowNetwork: [
        { host: "covered.example.com", ports: [443], wildcard: false },
      ],
    });
    app.project
      .givenContainer({ state: "running" })
      .network.block("covered.example.com", 443);

    const result = await app.cli.run("network", "allow");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "All blocked domains are configured. Restart the sandbox to apply the current policy.",
    );
    expect(app.tui.output()).not.toContain("Select domains to allow:");
    expect((await app.project.readConfig()).allowNetwork).toEqual([
      { host: "covered.example.com", ports: [443], wildcard: false },
    ]);
  });

  test("does not write configuration after an empty selection", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    app.project
      .givenContainer({ state: "running" })
      .network.block("ignored.example.com", 443);

    const execution = app.cli.run("network", "allow");
    await app.tui.waitForText("Select domains to allow:");
    await app.tui.user.enter();

    expect(await execution).toMatchObject({ exitCode: 0, stderr: "" });
    expect((await app.project.readConfig()).allowNetwork).toEqual([]);
    expect((await app.global.readConfig()).allowNetwork).toEqual([]);
  });

  test("returns an application failure when the user cancels", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    app.project
      .givenContainer({ state: "running" })
      .network.block("cancelled.example.com", 443);

    const execution = app.cli.run("network", "allow");
    await app.tui.waitForText("Select domains to allow:");
    await app.tui.user.chord("c", { ctrl: true });
    const result = await execution;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("The interactive prompt was cancelled.");
    expect((await app.project.readConfig()).allowNetwork).toEqual([]);
  });

  test("reports no running containers without prompting or writing config", async () => {
    await using app = await setupSandboxAppTest();

    const result = await app.cli.run("network", "allow");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("No running sandbox containers found.");
    expect(app.tui.output()).not.toContain("Select domains to allow:");
    expect(app.project.configExists()).toBe(false);
    expect(app.runtime.events()).toEqual([
      {
        type: "container.list",
        options: {
          labelFilter: expect.stringMatching(/^sandbox\.project=/),
          statusFilter: ["running"],
        },
      },
    ]);
  });

  test("keeps parallel application scopes isolated", async () => {
    await using first = await setupSandboxAppTest();
    await using second = await setupSandboxAppTest();

    const [firstResult, secondResult] = await Promise.all([
      first.cli.run("network", "allow"),
      second.cli.run("network", "allow"),
    ]);

    expect(first.project.root).not.toBe(second.project.root);
    expect(firstResult.stderr).toContain(
      "No running sandbox containers found.",
    );
    expect(secondResult.stderr).toContain(
      "No running sandbox containers found.",
    );
    expect(first.runtime.events()).toHaveLength(1);
    expect(second.runtime.events()).toHaveLength(1);
    expect(first.project.configExists()).toBe(false);
    expect(second.project.configExists()).toBe(false);
  });

  test("rejects concurrent executions on one application terminal", async () => {
    const app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    app.project
      .givenContainer({ state: "running" })
      .network.block("pending.example.com", 443);
    const execution = app.cli.run("network", "allow");
    await app.tui.waitForText("Select domains to allow:");

    expect(() => app.cli.run("--version")).toThrow(
      "Only one CLI execution may use an application terminal at a time.",
    );

    await app[Symbol.asyncDispose]();
    expect((await execution).exitCode).toBe(1);
  });

  test("aborts and settles an execution waiting for prompt input", async () => {
    const app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    app.project
      .givenContainer({ state: "running" })
      .network.block("pending.example.com", 443);
    const execution = app.cli.run("network", "allow");
    await app.tui.waitForText("Select domains to allow:");

    await app[Symbol.asyncDispose]();

    expect((await execution).exitCode).toBe(1);
  });

  test("disposes isolated roots when the test body throws", async () => {
    let appRoot = "";

    await expect(async () => {
      await using app = await setupSandboxAppTest();
      appRoot = path.dirname(app.project.root);
      throw new Error("test body failure");
    }).toThrow("test body failure");

    expect(fs.existsSync(appRoot)).toBe(false);
  });
});
