import { describe, expect, test } from "bun:test";
import { setupSandboxAppTest } from "./__test__/sandbox-app-test.js";

describe("sandbox network allow observations", () => {
  test("combines duplicate domains, mixed ports, DNS, and multiple containers", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const first = app.project.givenContainer({ state: "running" }).network;
    const second = app.project.givenContainer({ state: "running" }).network;
    first.block("multi.example", 80);
    first.block("multi.example", 443);
    second.block("multi.example", 443);
    second.block("dns.example", 0);

    const execution = app.cli.run("network", "allow");
    await app.tui.waitForText("Select domains to allow:");
    expect(app.tui.screen()).toContain("multi.example");
    expect(app.tui.screen()).toContain("dns.example");
    await app.tui.user.chord("c", { ctrl: true });
    expect((await execution).exitCode).toBe(1);
  });

  test("shows supplied blocked diagnostics while preventing duplicate covered entries", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({
      allowNetwork: [
        { host: "git.internal.example", ports: [22], wildcard: false },
      ],
    });
    const network = app.project.givenContainer({ state: "running" }).network;
    network.block("wikipedia.org", 443);
    network.block("example.com", 443);
    network.block("pi.dev", 443);
    network.block("git.internal.example", 22);

    const execution = app.cli.run("network", "allow");
    await app.tui.waitForText("Select domains to allow:");
    expect(app.tui.screen()).toContain("wikipedia.org:443");
    expect(app.tui.screen()).toContain("example.com:443");
    expect(app.tui.screen()).toContain("pi.dev:443");
    expect(app.tui.screen()).toContain("git.internal.example:22");
    expect(app.tui.screen()).toContain("Configured. Restart sandbox.");
    await app.tui.user.type("/wikipedia.org");
    await app.tui.user.enter();
    await app.tui.user.space();
    await app.tui.user.enter();
    await app.tui.waitForText("Add to which config?");
    await app.tui.user.down();
    await app.tui.user.enter();

    expect(await execution).toMatchObject({ exitCode: 0, stderr: "" });
    expect((await app.project.readConfig()).allowNetwork).toEqual([
      { host: "git.internal.example", ports: [22], wildcard: false },
      { host: "wikipedia.org", ports: [443], wildcard: false },
    ]);
  });

  test("reports that configured blocked domains need a sandbox restart", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({
      allowNetwork: [
        { host: "example.com", ports: [], wildcard: true },
        { host: "covered.test", ports: [443], wildcard: false },
      ],
    });
    const network = app.project.givenContainer({ state: "running" }).network;
    network.block("api.example.com", 80);
    network.block("covered.test", 443);

    const result = await app.cli.run("network", "allow");

    expect(result.stderr).toContain(
      "All blocked domains are configured. Restart the sandbox to apply the current policy.",
    );
    expect(app.tui.output()).not.toContain("Select domains to allow:");
  });

  test("reports real filesystem write failures", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    app.project
      .givenContainer({ state: "running" })
      .network.block("write-failure.example", 443);
    const execution = app.cli.run("network", "allow");
    await app.tui.waitForText("Select domains to allow:");
    app.project.makeConfigWriteFail();
    await app.tui.user.space();
    await app.tui.user.enter();
    await app.tui.waitForText("Add to which config?");
    await app.tui.user.down();
    await app.tui.user.enter();
    const result = await execution;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error:");
  });

  test("preserves runtime and trust failures without writing", async () => {
    await using runtimeFailure = await setupSandboxAppTest();
    runtimeFailure.runtime.system.fail("resolve", new Error("runtime failed"));
    const failed = await runtimeFailure.cli.run("network", "allow");
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("runtime failed");
    expect(runtimeFailure.project.configExists()).toBe(false);

    await using untrusted = await setupSandboxAppTest({ interactive: false });
    untrusted.project.writeConfig('allow_network = ["blocked.example"]\n');
    const rejected = await untrusted.cli.run("network", "allow");
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("not trusted");
  });
});
