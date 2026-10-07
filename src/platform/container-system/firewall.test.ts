import { describe, expect, test } from "bun:test";
import { setupContainerNetworkSystemTest } from "./__test__/index.js";

const rules = [
  ["-F", "OUTPUT"],
  ["-A", "OUTPUT", "-o", "lo", "-j", "ACCEPT"],
  ["-A", "OUTPUT", "-m", "owner", "--uid-owner", "proxy", "-j", "ACCEPT"],
  ["-A", "OUTPUT", "-j", "NFLOG", "--nflog-group", "100"],
  ["-A", "OUTPUT", "-j", "REJECT"],
];

describe("firewall restore", () => {
  for (const family of ["ipv4", "ipv6"] as const) {
    test(`installs ${family} OUTPUT rules in one filter transaction without flushing other chains`, async () => {
      await using fixture = await setupContainerNetworkSystemTest();
      const child = fixture.processes.expectStart();
      const installation = fixture.run((network) =>
        family === "ipv4"
          ? network.applyFirewall(rules)
          : network.applyIpv6Firewall(rules),
      );
      expect(await child.waitForStart()).toMatchObject({
        command: `/usr/sbin/${family === "ipv4" ? "iptables" : "ip6tables"}-restore`,
        args: ["--noflush"],
        stdio: "stream",
      });
      const lines = Buffer.from(await child.waitForInput())
        .toString()
        .trim()
        .split("\n");
      expect(lines.shift()).toBe("*filter");
      expect(lines.pop()).toBe("COMMIT");
      expect(lines.map((line) => line.split(" "))).toEqual(rules);
      await child.waitForInputEnd();
      child.exit();
      await installation;
      expect(fixture.processes.requests).toHaveLength(1);
    });
  }

  test("does not start a process for an empty plan", async () => {
    await using fixture = await setupContainerNetworkSystemTest();
    await fixture.run(async (network) => {
      await network.applyFirewall([]);
      await network.applyIpv6Firewall([]);
    });
    expect(fixture.processes.requests).toEqual([]);
  });

  test("rejects restore syntax injection before starting a process", async () => {
    await using fixture = await setupContainerNetworkSystemTest();
    await expect(
      fixture.run((network) =>
        network.applyIpv6Firewall([
          ...rules,
          ["-A", "OUTPUT", "-o", "eth0\nCOMMIT\n*filter\n-F"],
        ]),
      ),
    ).rejects.toThrow("Invalid firewall argument");
    expect(fixture.processes.requests).toEqual([]);
  });

  test("cancels a pending restore input write", async () => {
    await using fixture = await setupContainerNetworkSystemTest();
    const child = fixture.processes.expectStart({ rejectOnAbort: true });
    child.pauseInput();
    const installation = fixture.run((network) => network.applyFirewall(rules));
    await child.waitForInput();
    fixture.cancel(new Error("restore cancelled"));
    await expect(installation).rejects.toThrow("restore cancelled");
  });

  test("stops a live restore child when its input closes", async () => {
    await using fixture = await setupContainerNetworkSystemTest();
    const child = fixture.processes.expectStart();
    child.pauseInput();
    child.exitOnSignal();
    const installation = fixture.run((network) => network.applyFirewall(rules));
    void installation.catch(() => undefined);
    await child.waitForInput();
    child.failInput(new Error("EPIPE"));
    for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
    expect(child.signals).toEqual(["SIGTERM"]);
    await expect(installation).rejects.toThrow("terminated by signal SIGTERM");
  });

  test("forces a restore child to stop when closed input and SIGTERM do not stop it", async () => {
    await using fixture = await setupContainerNetworkSystemTest();
    const child = fixture.processes.expectStart();
    child.pauseInput();
    child.exitOnSignal("SIGKILL");
    const installation = fixture.run((network) => network.applyFirewall(rules));
    void installation.catch(() => undefined);
    await child.waitForInput();
    child.failInput(new Error("EPIPE"));
    await child.waitForSignal();
    await fixture.clock.waitForSleep();
    await fixture.clock.advanceToNext();
    await expect(installation).rejects.toThrow("terminated by signal SIGKILL");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(fixture.clock.pendingSleeps()).toBe(0);
  });

  test("preserves restore failure diagnostics when input fails after an early exit", async () => {
    await using fixture = await setupContainerNetworkSystemTest();
    const child = fixture.processes.expectStart();
    child.pauseInput();
    const installation = fixture.run((network) => network.applyFirewall(rules));
    await child.waitForInput();
    child.emitStderr("invalid rule\n");
    child.exit({ exitCode: 7 });
    await expect(installation).rejects.toMatchObject({
      exitCode: 7,
      message:
        "/usr/sbin/iptables-restore failed with exit code 7: invalid rule",
    });
  });
});
