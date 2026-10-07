import { describe, expect, test } from "bun:test";
import { setupSandboxAppTest } from "./__test__/sandbox-app-test.js";

describe("sandbox doctor", () => {
  test("reports a healthy environment without a host X11 requirement", async () => {
    await using app = await setupSandboxAppTest();
    app.global.writeConfig("settings = []\n");
    app.global.givenSettings();
    const result = await app.cli.run("doctor");
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Sandbox Doctor");
    expect(result.stdout).toContain("docker 24.0.0 detected");
    expect(result.stdout).toContain("Config syntax valid");
    expect(result.stdout).toContain("All checks passed!");
  });

  test("reports Apple container and its per-container memory scope", async () => {
    await using app = await setupSandboxAppTest({ runtime: "apple-container" });
    app.runtime.system.givenVersion("container CLI version 1.4.1");
    app.runtime.system.givenMemoryBytes(2 * 1024 ** 3);
    const result = await app.cli.run("doctor");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("apple-container 1.4.1 detected");
    expect(result.stdout).toContain("Per-container memory: 2.0GB");
  });

  test("reports missing runtime without legacy display guidance", async () => {
    await using app = await setupSandboxAppTest();
    app.runtime.system.fail("resolve", new Error("runtime missing"));
    const result = await app.cli.run("doctor");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Not available");
    expect(result.stdout).toContain("error");
  });

  test("rejects invalid configuration", async () => {
    await using app = await setupSandboxAppTest();
    app.global.writeConfig("invalid = [\n");
    const result = await app.cli.run("doctor");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("config.toml");
  });

  test("contains individual check failures without changing exit behavior", async () => {
    await using app = await setupSandboxAppTest();
    app.runtime.system.fail("version", new Error("daemon unavailable"));
    const result = await app.cli.run("doctor");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Install Docker, Podman, or Apple container",
    );
  });
});
