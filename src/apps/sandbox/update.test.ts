import { describe, expect, test } from "bun:test";
import { setupSandboxAppTest } from "./__test__/sandbox-app-test.js";

const packageName = "@maibornwolff/sandbox";

describe("sandbox update", () => {
  test("reports an up-to-date installation through real Commander", async () => {
    await using app = await setupSandboxAppTest();

    const result = await app.cli.run("update");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Checking for updates");
    expect(result.stderr).toContain("Already on latest version");
    expect(app.updates.operations()).toEqual([
      { type: "version.lookup", packageName },
    ]);
  });

  test("uses scoped cache timestamps and exposes verbose cache guidance", async () => {
    await using app = await setupSandboxAppTest();
    app.workspace.writeRootFile(
      "data/sandbox/state.json",
      JSON.stringify({
        latestVersion: "0.0.0-development",
        latestVersionCheckedAt: app.clock.currentTime(),
      }),
    );
    app.processes
      .expectStart({ match: { name: "container log stream" } })
      .resolveResult({ exitCode: 0, stdout: "", stderr: "" });
    app.processes
      .expectStart({ match: { stdio: "inherit" } })
      .resolveResult({ exitCode: 0, stdout: "", stderr: "" });

    const result = await app.cli.run("--verbose", "run", "node");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Using cached Sandbox update check");
    expect(app.updates.operations()).toEqual([]);
  });

  test("updates an accepted release, migrates changed templates, and prints guidance", async () => {
    await using app = await setupSandboxAppTest();
    app.updates.givenPackageVersion(packageName, "2.0.0");

    const execution = app.cli.run("--verbose", "update");
    await app.tui.waitForText("Update to 2.0.0?");
    await app.tui.user.enter();
    const result = await execution;

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Updated to 2.0.0");
    expect(result.stdout).toContain("Checking for configuration updates");
    expect(result.stdout).toContain("Next steps:");
    expect(result.stdout).toContain("sandbox upgrade --user");
    expect(app.updates.installedVersion(packageName)).toBe("2.0.0");
    expect(app.updates.operations()).toEqual([
      { type: "version.lookup", packageName },
      { type: "package.update", packageName },
      {
        type: "binary.run",
        binaryName: "sandbox",
        args: ["config", "update"],
      },
    ]);
  });

  test("preserves rejected and cancelled confirmations", async () => {
    await using rejected = await setupSandboxAppTest();
    rejected.updates.givenPackageVersion(packageName, "2.0.0");
    const rejection = rejected.cli.run("update");
    await rejected.tui.waitForText("Update to 2.0.0?");
    await rejected.tui.user.type("n");
    const rejectedResult = await rejection;
    expect(rejectedResult.exitCode).toBe(0);
    expect(rejectedResult.stderr).toContain("Checking for updates");
    expect(rejected.updates.installedVersion(packageName)).toBe(
      "0.0.0-development",
    );

    await using cancelled = await setupSandboxAppTest();
    cancelled.updates.givenPackageVersion(packageName, "2.0.0");
    const cancellation = cancelled.cli.run("update");
    await cancelled.tui.waitForText("Update to 2.0.0?");
    await cancelled.tui.user.chord("c", { ctrl: true });
    const cancelledResult = await cancellation;
    expect(cancelledResult.exitCode).toBe(0);
    expect(cancelledResult.stderr).toContain("Checking for updates");
    expect(cancelledResult.stdout).toContain("Cancelled.");
    expect(cancelled.updates.installedVersion(packageName)).toBe(
      "0.0.0-development",
    );
  });

  test("reports registry and package update failures without template migration", async () => {
    await using registry = await setupSandboxAppTest();
    registry.updates.failRegistry(packageName);
    const registryResult = await registry.cli.run("update");
    expect(registryResult.exitCode).toBe(0);
    expect(registryResult.stderr).toContain("Failed to check for updates");

    await using update = await setupSandboxAppTest();
    update.updates.givenPackageVersion(packageName, "2.0.0");
    update.updates.failUpdate(packageName);
    const execution = update.cli.run("update");
    await update.tui.waitForText("Update to 2.0.0?");
    await update.tui.user.enter();
    const result = await execution;
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Update failed (permission denied)");
    expect(result.stderr).toContain(
      "npm cannot update the global package because of insufficient permissions.",
    );
    expect(result.stderr).toContain(
      "Fix npm global installation permissions or use a Node.js version manager, then retry the update.",
    );
    expect(update.updates.installedVersion(packageName)).toBe(
      "0.0.0-development",
    );
    expect(update.updates.operations()).not.toContainEqual(
      expect.objectContaining({ type: "binary.run" }),
    );
  });

  test("recognizes unchanged templates on a repeated real update", async () => {
    await using app = await setupSandboxAppTest();
    app.updates.givenPackageVersion(packageName, "2.0.0");

    const first = app.cli.run("update");
    await app.tui.waitForText("Update to 2.0.0?");
    await app.tui.user.enter();
    expect((await first).exitCode).toBe(0);

    const second = app.cli.run("update");
    await app.tui.waitForText("Update to 2.0.0?");
    await app.tui.user.enter();
    const result = await second;

    expect(result.stderr).toContain("Configuration already up to date");
    expect(
      app.updates
        .operations()
        .filter((operation) => operation.type === "binary.run"),
    ).toHaveLength(1);
  });
});
