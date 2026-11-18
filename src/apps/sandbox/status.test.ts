import { describe, expect, test } from "bun:test";
import { stripAnsi } from "#test/utils.js";
import { setupSandboxAppTest } from "./__test__/sandbox-app-test.js";

const CLAUDE_SESSION_ID = "6f1c0d3e-9a4b-4c2d-8e7f-1a2b3c4d5e6f";
const SHELL_SESSION_ID = "a82b48cf-c10b-48ed-9fc4-193b80ef2856";

describe("sandbox status", () => {
  test("shows an empty project status", async () => {
    await using app = await setupSandboxAppTest();
    const result = await app.cli.run("status");
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Sandbox Status");
    expect(result.stdout).toContain("Runtime");
    expect(result.stdout).toContain("docker");
    expect(result.stdout).toContain("No active containers.");
  });

  test("shows running containers, uptime, hashes, and active sessions", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    app.project.givenContainer({
      state: "running",
      uptime: "Up 2 hours",
      hash: "abc123",
      sessions: [
        {
          pid: 43,
          startedAt: new Date("2026-01-01T00:05:00Z"),
          id: SHELL_SESSION_ID,
          command: ["zsh"],
        },
        {
          pid: 42,
          startedAt: new Date("2026-01-01T00:01:00Z"),
          id: CLAUDE_SESSION_ID,
          command: ["claude", "--resume", "fix the bug"],
          title: ["claude"],
        },
      ],
    });
    app.project.givenContainer({ state: "exited", uptime: "Exited" });

    const result = await app.cli.run("status");
    const stdout = stripAnsi(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("● sandbox-");
    expect(stdout).toContain("Up 2 hours");
    expect(stdout).toContain("abc123");
    expect(stdout).toContain("2 active");
    expect(stdout).toContain(
      "├ claude --resume 'fix the bug'  6f1c0d3e  (PID 42)\n",
    );
    expect(stdout).toContain("└ zsh  a82b48cf  (PID 43)\n");
    expect(stdout).not.toContain("Exited");
  });

  test("shows the process command line of a session with an older marker", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    app.project.givenContainer({
      state: "running",
      sessions: [{ pid: 361, title: ["pi"] }],
    });

    const result = await app.cli.run("status");

    expect(stripAnsi(result.stdout)).toContain("└ pi  (PID 361)\n");
  });

  test("marks a container without the ready marker as starting", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const { sessionStatus } = app.project.givenContainer({ state: "running" });
    sessionStatus.givenReady(false);

    const result = await app.cli.run("status");
    const stdout = stripAnsi(result.stdout);

    expect(stdout).toMatch(/◐ sandbox-\S+ {2}starting\n/u);
    expect(stdout).toContain("Sessions  none");
  });

  test("shows unknown sessions when the status probe fails", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const { sessionStatus } = app.project.givenContainer({ state: "running" });
    sessionStatus.fail(new Error("probe exec failed"));

    const result = await app.cli.run("--verbose", "status");
    const stdout = stripAnsi(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(stdout).toMatch(/○ sandbox-\S+ {2}Up /u);
    expect(stdout).toContain("Sessions  unknown");
    expect(stripAnsi(result.stderr)).toContain(
      "Could not read the session status of sandbox-",
    );
    expect(result.stderr).toContain("probe exec failed");
  });

  test("runs one status probe as root for each running container", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const first = app.project.givenContainer({ state: "running" });
    const second = app.project.givenContainer({ state: "running" });
    app.project.givenContainer({ state: "exited" });

    const result = await app.cli.run("status");

    expect(stripAnsi(result.stdout).match(/Up 1 minute/g)).toHaveLength(2);
    const probes = app.runtime
      .events()
      .filter((event) => event.type === "container.exec")
      .map((event) => [event.containerId, event.options.user]);
    expect(probes.sort()).toEqual(
      [
        [first.id, "root"],
        [second.id, "root"],
      ].sort(),
    );
  });

  test("preserves a runtime failure", async () => {
    await using failing = await setupSandboxAppTest();
    failing.runtime.system.fail("resolve", new Error("runtime failed"));
    const failed = await failing.cli.run("status");
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("runtime failed");
  });

  test("shows status in an untrusted project with and without a terminal", async () => {
    for (const interactive of [true, false]) {
      await using app = await setupSandboxAppTest({ interactive });
      app.project.writeConfig("readonly = true\n");
      app.project.givenContainer({ state: "running" });

      const result = await app.cli.run("status");

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(result.stdout).toContain("Up 1 minute");
      expect(app.tui.output()).not.toContain("Trust this project config?");
      expect(app.workspace.configFileExists("trusted-projects.json")).toBe(
        false,
      );
    }
  });

  test("shows the user runtime when the project config selects another runtime", async () => {
    await using app = await setupSandboxAppTest({ runtime: "podman" });
    app.global.writeConfig('runtime = "podman"\n');
    await app.project.givenConfig({ allowNetwork: [], runtime: "docker" });

    const result = await app.cli.run("status");

    expect(result.exitCode).toBe(0);
    expect(stripAnsi(result.stdout)).toMatch(/Runtime\s+podman/u);
    expect(app.runtime.resolvedConfigurations()).toEqual(["podman"]);
  });

  test("detects the runtime when only the project config selects a runtime", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [], runtime: "podman" });

    const result = await app.cli.run("status");

    expect(result.exitCode).toBe(0);
    expect(stripAnsi(result.stdout)).toMatch(/Runtime\s+docker/u);
    expect(app.runtime.resolvedConfigurations()).toEqual([undefined]);
  });

  test("fails with an invalid user config", async () => {
    await using app = await setupSandboxAppTest();
    app.global.writeConfig('runtime = "unknown"\n');

    const result = await app.cli.run("status");

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toContain(
      `Invalid config at ${app.workspace.configRoot}/config.toml`,
    );
    expect(app.runtime.resolvedConfigurations()).toEqual([]);
  });
});
