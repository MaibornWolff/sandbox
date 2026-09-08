import { describe, expect, test } from "bun:test";
import { setupSandboxAppTest } from "./__test__/sandbox-app-test.js";

describe("sandbox doctor", () => {
  test("reports a healthy environment", async () => {
    await using app = await setupSandboxAppTest({
      variables: { DISPLAY: ":0" },
    });
    app.global.writeConfig("settings = []\n");
    app.global.givenSettings();
    app.diagnostics.givenX11ServerAvailable();
    app.diagnostics.givenXHostConfigured();

    const result = await app.cli.run("doctor");
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Sandbox Doctor");
    expect(result.stdout).toContain("docker 24.0.0 detected");
    expect(result.stdout).toContain("X11 available (:0)");
    expect(result.stdout).toContain("Config syntax valid");
    expect(result.stdout).toContain("All checks passed!");
  });

  test("reports missing runtime and unsupported X11 as a summary", async () => {
    await using app = await setupSandboxAppTest();
    app.runtime.system.fail("resolve", new Error("runtime missing"));
    const result = await app.cli.run("doctor");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Not available");
    expect(result.stdout).toContain("X11 not available");
    expect(result.stdout).toContain("warning");
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
    expect(result.stdout).toContain("Install Docker or Podman");
  });
});

describe("sandbox setup-x11", () => {
  test("reports a supported configured Linux setup", async () => {
    await using app = await setupSandboxAppTest({
      variables: { DISPLAY: ":0" },
    });
    app.diagnostics.givenX11ServerAvailable();
    app.diagnostics.givenXHostConfigured();
    const result = await app.cli.run("setup-x11");
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Platform: Linux");
    expect(result.stdout).toContain("X11 clipboard is fully configured");
  });

  test("shows guidance when tools or commands are unavailable", async () => {
    await using app = await setupSandboxAppTest({
      variables: { DISPLAY: ":0" },
    });
    app.diagnostics.failCommand("xdpyinfo");
    const result = await app.cli.run("setup-x11");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("X11 clipboard setup incomplete");
    expect(result.stdout).toContain("xhost +localhost");
    expect(result.stdout).toContain("docs/X11-SETUP.md");
  });

  test("shows missing XQuartz guidance on macOS", async () => {
    await using app = await setupSandboxAppTest({ platform: "darwin" });
    app.diagnostics.failCommand("which", ["xquartz"]);
    const result = await app.cli.run("setup-x11");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("macOS (darwin)");
    expect(result.stdout).toContain("Install XQuartz");
  });

  test("supports Windows X servers", async () => {
    await using app = await setupSandboxAppTest({ platform: "win32" });
    app.diagnostics.givenWindowsXServerAvailable();
    const result = await app.cli.run("setup-x11");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Platform: Windows");
    expect(result.stdout).toContain("fully configured");
  });

  test("shows unsupported platform guidance without failing", async () => {
    await using app = await setupSandboxAppTest({ platform: "freebsd" });
    const result = await app.cli.run("setup-x11");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Platform freebsd is not fully supported");
  });
});
