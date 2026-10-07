import { describe, expect, test } from "bun:test";
import { setupContainerNetworkSystemTest } from "./__test__/index.js";
import { getSquidDomainAclPath } from "./network-bootstrap.js";

const DNS_CONFIG = "dns config\n";
const SQUID_CONFIG = "squid config\n";
const DNS_ENDPOINT = { host: "127.0.0.1", port: 53 } as const;
const SQUID_ENDPOINT = { host: "127.0.0.1", port: 8888 } as const;

async function waitForSleep(
  fixture: Awaited<ReturnType<typeof setupContainerNetworkSystemTest>>,
): Promise<void> {
  while (fixture.clock.pendingSleeps() === 0) await Promise.resolve();
}

async function advanceRetry(
  fixture: Awaited<ReturnType<typeof setupContainerNetworkSystemTest>>,
): Promise<void> {
  await waitForSleep(fixture);
  await fixture.clock.advanceBy(50);
}

describe("container network system", () => {
  test("uses the rooted filesystem for the upstream resolver", async () => {
    await using fixture = await setupContainerNetworkSystemTest({
      SANDBOX_DEBUG: "1",
    });
    fixture.writeFile(
      "/etc/resolv.conf",
      "search local\nnameserver 10.0.0.2\n",
    );
    await fixture.run(async (network) => {
      expect(await network.discoverUpstreamDns()).toBe("10.0.0.2");
    });
    expect(fixture.readFile("/etc/resolv.conf.upstream")).toContain("10.0.0.2");
  });

  test("discovers only a valid upstream resolver", async () => {
    await using fixture = await setupContainerNetworkSystemTest();
    fixture.writeFile("/etc/resolv.conf", "search local\n");
    await expect(
      fixture.run((network) => network.discoverUpstreamDns()),
    ).rejects.toThrow("No upstream DNS server found");
  });

  test("starts managed dnsmasq and becomes ready after a deterministic retry", async () => {
    await using fixture = await setupContainerNetworkSystemTest();
    const child = fixture.givenManagedChild("dnsmasq");
    fixture.givenClosed(DNS_ENDPOINT);
    const startup = fixture.run((network) =>
      network.startDnsmasq({ config: DNS_CONFIG }),
    );
    await waitForSleep(fixture);
    fixture.givenListening(DNS_ENDPOINT);
    await fixture.clock.advanceBy(5);
    expect(fixture.tcp.attempts()).toHaveLength(2);

    await expect(startup).resolves.toBeUndefined();
    expect(fixture.readFile("/etc/dnsmasq.d/sandbox.conf")).toBe(DNS_CONFIG);
    expect(fixture.readFile("/etc/resolv.conf")).toBe("nameserver 127.0.0.1\n");
    expect(fixture.processes.requests[0]).toMatchObject({
      command: "/usr/sbin/dnsmasq",
      args: ["--keep-in-foreground", "--conf-dir=/etc/dnsmasq.d"],
    });
    expect(fixture.tcp.attempts()).toHaveLength(2);
    child.exit();
  });

  test("backs off readiness retries to a bounded interval", async () => {
    await using fixture = await setupContainerNetworkSystemTest();
    fixture.givenManagedChild("dnsmasq");
    fixture.givenClosed(DNS_ENDPOINT);
    const startup = fixture.run((network) =>
      network.startDnsmasq({ config: DNS_CONFIG }),
    );
    let attempts = 1;
    for (const interval of [5, 10, 20, 40, 50, 50]) {
      await waitForSleep(fixture);
      await fixture.clock.advanceBy(interval - 1);
      expect(fixture.tcp.attempts()).toHaveLength(attempts);
      await fixture.clock.advanceBy(1);
      attempts += 1;
      expect(fixture.tcp.attempts()).toHaveLength(attempts);
    }
    fixture.givenListening(DNS_ENDPOINT);
    await advanceRetry(fixture);
    await startup;
  });

  test("polls quickly while preserving the dnsmasq startup deadline", async () => {
    await using fixture = await setupContainerNetworkSystemTest();
    fixture.givenManagedChild("dnsmasq");
    fixture.givenClosed(DNS_ENDPOINT);
    const startup = fixture
      .run((network) => network.startDnsmasq({ config: DNS_CONFIG }))
      .catch((error: unknown) => error);
    for (let elapsed = 0; elapsed < 5_000; elapsed += 50) {
      await advanceRetry(fixture);
    }

    const error = await startup;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "dnsmasq failed to start on 127.0.0.1:53",
    );
    expect(fixture.clock.currentTime()).toBe(5_000);
    expect(fixture.tcp.attempts().length).toBeGreaterThanOrEqual(100);
    expect(fixture.tcp.attempts().length).toBeLessThan(110);
  });

  test("reports managed child failure before readiness", async () => {
    await using fixture = await setupContainerNetworkSystemTest();
    const child = fixture.givenManagedChild("dnsmasq");
    fixture.givenClosed(DNS_ENDPOINT);
    const startup = fixture.run((network) =>
      network.startDnsmasq({ config: DNS_CONFIG }),
    );
    await waitForSleep(fixture);
    child.exit({
      exitCode: 7,
      stderr: "invalid domain ACL\n",
      stdout: "startup context\n",
    });

    await expect(startup).rejects.toThrow(
      "dnsmasq exited with code 7 before becoming ready: invalid domain ACL\nstartup context",
    );
    expect(fixture.processes.requests[0]).toMatchObject({
      command: "/usr/sbin/dnsmasq",
      args: ["--keep-in-foreground", "--conf-dir=/etc/dnsmasq.d"],
      name: "dnsmasq",
    });
  });

  test("keeps the managed child private after TCP readiness", async () => {
    await using fixture = await setupContainerNetworkSystemTest();
    fixture.givenManagedChild("dnsmasq");
    fixture.givenListening(DNS_ENDPOINT);
    await expect(
      fixture.run((network) => network.startDnsmasq({ config: DNS_CONFIG })),
    ).resolves.toBeUndefined();
    expect(
      fixture.processes.actions().find((action) => action.type === "start"),
    ).toMatchObject({ request: { name: "dnsmasq" } });
  });

  test("prepares Squid diagnostics and starts the managed child with exact arguments", async () => {
    await using fixture = await setupContainerNetworkSystemTest({
      SANDBOX_DEBUG: "1",
    });
    fixture.writeFile(
      "/usr/share/squid/errors/en/ERR_ACCESS_DENIED",
      "default",
    );
    fixture.givenListening(SQUID_ENDPOINT);
    for (let request = 0; request < 3; request += 1) {
      fixture.processes
        .expectStart()
        .resolveResult({ exitCode: 0, stdout: "", stderr: "" });
    }

    fixture.givenManagedChild("squid");
    await fixture.run((network) =>
      network.startSquid({
        config: SQUID_CONFIG,
        domainAclGroups: [
          { id: 0, content: ".example.com\n" },
          { id: 1, content: "api.example.net\n" },
        ],
        blockedErrorPage: "blocked\n",
      }),
    );

    expect(fixture.readFile("/etc/squid/squid.conf")).toBe(SQUID_CONFIG);
    expect(getSquidDomainAclPath(0)).toBe(
      "/var/run/proxy-allowed-domains-0.txt",
    );
    expect(getSquidDomainAclPath(1)).toBe(
      "/var/run/proxy-allowed-domains-1.txt",
    );
    expect(fixture.readFile(getSquidDomainAclPath(0))).toBe(".example.com\n");
    expect(fixture.readFile(getSquidDomainAclPath(1))).toBe(
      "api.example.net\n",
    );
    expect(
      fixture.readFile("/usr/share/squid/errors/custom/ERR_SANDBOX_BLOCKED"),
    ).toBe("blocked\n");
    expect(fixture.fileExists("/var/log/proxy-access.log")).toBe(true);
    expect(fixture.fileExists("/var/log/squid-cache.log")).toBe(true);
    expect(fixture.processes.requests).toContainEqual(
      expect.objectContaining({
        command: "/usr/sbin/squid",
        args: ["-N", "-f", "/etc/squid/squid.conf"],
      }),
    );
    expect(fixture.output.stderr()).toContain(
      "network: prepared 2 Squid domain ACL groups",
    );
  });

  test("surfaces deterministic TCP connection failures", async () => {
    await using fixture = await setupContainerNetworkSystemTest();
    fixture.givenManagedChild("dnsmasq");
    fixture.givenConnectionFailure(DNS_ENDPOINT, new Error("socket failed"));
    await expect(
      fixture.run((network) => network.startDnsmasq({ config: DNS_CONFIG })),
    ).rejects.toThrow("socket failed");
  });

  test("starts a managed trace with default privilege dropping and supports shutdown", async () => {
    await using fixture = await setupContainerNetworkSystemTest();
    const child = fixture.givenManagedChild("tcpdump");
    await fixture.run(async (network) => {
      await network.startNetworkTrace();
      const stopping = fixture.processes.manager.stopAll();
      child.exit({ signal: "SIGTERM" });
      await stopping;
    });

    expect(fixture.fileExists("/var/log/firewall-blocked.log")).toBe(true);
    expect(fixture.processes.requests).toEqual([
      expect.objectContaining({
        command: "/usr/bin/tcpdump",
        args: ["-i", "nflog:100", "-l", "-n", "-tt"],
        stdoutFile: {
          path: `${fixture.root}/var/log/firewall-blocked.log`,
          append: true,
        },
      }),
    ]);
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  test("cancels readiness waits and cleans pending clock state", async () => {
    await using fixture = await setupContainerNetworkSystemTest();
    fixture.givenManagedChild("dnsmasq");
    fixture.givenClosed(DNS_ENDPOINT);
    const startup = fixture.run((network) =>
      network.startDnsmasq({ config: DNS_CONFIG }),
    );
    await waitForSleep(fixture);
    fixture.cancel();

    await expect(startup).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.clock.pendingSleeps()).toBe(0);
  });
});
