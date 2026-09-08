import { describe, expect, test } from "bun:test";
import { setupSandboxAppTest } from "./__test__/sandbox-app-test.js";

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
        { pid: "42", command: "claude" },
        { pid: "43", command: "bash" },
      ],
    });
    app.project.givenContainer({ state: "exited", uptime: "Exited" });

    const result = await app.cli.run("status");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Up 2 hours");
    expect(result.stdout).toContain("abc123");
    expect(result.stdout).toContain("2 active");
    expect(result.stdout).toContain("claude");
    expect(result.stdout).not.toContain("Exited");
  });

  test("shows multiple running resources and preserves runtime failure", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    app.project.givenContainer({ state: "running" });
    app.project.givenContainer({ state: "running" });
    const result = await app.cli.run("status");
    expect(result.stdout.match(/Up 1 minute/g)).toHaveLength(2);

    await using failing = await setupSandboxAppTest();
    failing.runtime.system.fail("resolve", new Error("runtime failed"));
    const failed = await failing.cli.run("status");
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("runtime failed");
  });
});
