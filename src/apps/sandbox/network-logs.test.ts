import { describe, expect, test } from "bun:test";
import { setupSandboxAppTest } from "./__test__/sandbox-app-test.js";

describe("sandbox network logs", () => {
  test("reports no running containers through stderr", async () => {
    await using app = await setupSandboxAppTest();
    const result = await app.cli.run("network", "logs");
    const aliasResult = await app.cli.run("network", "l");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "No running sandbox containers found for this project.",
    );
    expect(aliasResult).toEqual(result);
  });

  test("shows blocked observations and stable guidance", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const network = app.project.givenContainer({ state: "running" }).network;
    network.block("blocked.example", 443);
    network.allow("allowed.example", 443);

    const result = await app.cli.run("network", "logs");
    expect(result.stdout).toContain("blocked.example");
    expect(result.stdout).not.toContain("allowed.example");
    expect(result.stdout).toContain("--status=all");
    expect(result.stdout).toContain("sandbox network allow");
  });

  test("shows all statuses, DNS entries, aggregation, and multiple containers", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const first = app.project.givenContainer({ state: "running" }).network;
    const second = app.project.givenContainer({ state: "running" }).network;
    first.block("repeated.example", 443);
    first.block("repeated.example", 443);
    first.block("dns-only.example", 0);
    first.resolve("deduplicated.example", "1.2.3.4");
    first.allow("deduplicated.example", 443);
    second.allow("allowed.example", 80);
    second.malformed("firewall", "malformed diagnostic line");

    const result = await app.cli.run(
      "network",
      "logs",
      "--status=all",
      "--no-resolve",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("repeated.example");
    const dnsLine = result.stdout
      .split("\n")
      .find((line) => line.includes("dns-only.example"));
    expect(dnsLine).toContain("DNS");
    expect(result.stdout).toContain("allowed.example");
    expect(
      result.stdout
        .split("\n")
        .filter((line) => line.includes("deduplicated.example")),
    ).toHaveLength(1);
    expect(result.stdout).toContain("ALLOWED");
    expect(result.stdout).toContain("BLOCKED");
  });

  test("maps firewall IPs from DNS observations", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const network = app.project.givenContainer({ state: "running" }).network;
    network.blockIp("1.2.3.4", 443);
    network.resolve("mapped.example", "1.2.3.4");

    const result = await app.cli.run("network", "logs");
    expect(result.stdout).toContain("mapped.example");
    expect(result.stdout).not.toContain("1.2.3.4");
  });

  test("renders all raw sources and partial collection failures", async () => {
    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const network = app.project.givenContainer({ state: "running" }).network;
    network.givenRuntimeLogs("runtime output");
    network.givenNetworkState("dnsmasq: running");
    network.givenProxyCache("cache warning");
    network.fail("firewall", new Error("firewall unavailable"));

    const result = await app.cli.run("network", "logs", "--raw");
    expect(result.exitCode).toBe(0);
    for (const heading of [
      "CONTAINER LOG",
      "NETWORK STATE",
      "FIREWALL LOG",
      "DNS LOG",
      "PROXY ACCESS LOG",
      "PROXY CACHE LOG",
    ]) {
      expect(result.stdout).toContain(heading);
    }
    expect(result.stdout).toContain(
      "Failed to collect diagnostic: firewall unavailable",
    );
  });

  test("preserves runtime failures and configured Podman selection", async () => {
    await using failing = await setupSandboxAppTest();
    failing.runtime.system.fail("resolve", new Error("daemon unavailable"));
    const failed = await failing.cli.run("network", "logs");
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("daemon unavailable");

    await using podman = await setupSandboxAppTest({ runtime: "podman" });
    await podman.project.givenConfig({ allowNetwork: [], runtime: "podman" });
    const result = await podman.cli.run("network", "logs");
    expect(result.exitCode).toBe(0);
    expect(podman.runtime.resolvedConfigurations()).toEqual(["podman"]);
  });
});
