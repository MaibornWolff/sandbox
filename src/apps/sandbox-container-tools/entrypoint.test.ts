import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import {
  type ContainerToolsAppTest,
  type ContainerToolsChild,
  setupContainerToolsAppTest,
} from "./__test__/index.js";

const DNS_ENDPOINT = { host: "127.0.0.1", port: 53 } as const;
const PROXY_ENDPOINT = { host: "127.0.0.1", port: 8888 } as const;
const DISABLED_NETWORK = JSON.stringify({
  enabled: false,
  allowNetwork: [],
  fullNetwork: false,
  noProxy: false,
});
const MANAGED_NETWORK = JSON.stringify({
  enabled: true,
  allowNetwork: [{ host: "example.com", ports: [443], wildcard: false }],
  fullNetwork: false,
  noProxy: false,
});
const NO_PROXY_NETWORK = JSON.stringify({
  enabled: true,
  allowNetwork: [],
  fullNetwork: false,
  noProxy: true,
});

function givenSuccessfulFirewallCommands(app: ContainerToolsAppTest): void {
  for (const command of ["iptables-restore", "ip6tables-restore"]) {
    const child = app.processes.expectStart({
      match: { command: `/usr/sbin/${command}`, stdio: "stream" },
    });
    void child.waitForInputEnd().then(() => child.exit());
  }
  for (let command = 0; command < 2; command += 1) {
    app.processes
      .expectStart({ match: { command: "/usr/bin/chown" } })
      .resolveResult({ exitCode: 0, stdout: "", stderr: "" });
  }
}

function givenPendingSettings(app: ContainerToolsAppTest) {
  return app.processes.expectStart({
    match: {
      command: "/usr/sbin/gosu",
      args: [
        "sandbox",
        "/usr/local/bin/sandbox-container-tools",
        "settings",
        "apply",
      ],
    },
  });
}

function givenProxyServices(app: ContainerToolsAppTest) {
  givenSuccessfulFirewallCommands(app);
  app.networkState.givenFile("/etc/resolv.conf", "nameserver 10.0.0.2\n");
  const dnsmasq = app.children.givenRequired("dnsmasq");
  const squid = app.children.givenRequired("squid");
  return { dnsmasq, squid };
}

function childEventLabels(app: ContainerToolsAppTest): readonly string[] {
  return app.children.events().flatMap((action) => {
    if (action.type === "start" && action.request.name) {
      return [`spawn:${action.request.name}`];
    }
    if (action.type === "signal") {
      return [`signal:${action.process.name ?? "unnamed"}:${action.signal}`];
    }
    return [];
  });
}

async function stopReadyEntrypoint(
  app: ContainerToolsAppTest,
  execution: Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>,
  children: readonly ContainerToolsChild[] = [],
) {
  app.signals.send("SIGTERM");
  await Promise.all(children.map((child) => child.waitForSignal()));
  for (const child of children) child.exit({ signal: "SIGTERM" });
  return await execution;
}

async function advanceIdleTicks(
  app: ContainerToolsAppTest,
  count: number,
): Promise<void> {
  for (let tick = 0; tick < count; tick += 1) {
    await app.idle.waitForTick();
    await app.idle.advanceToNextTick();
  }
}

async function waitForChildSignal(
  child: ContainerToolsChild,
  signal: NodeJS.Signals,
): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (child.signals.includes(signal)) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for child signal ${signal}.`);
}

function finalLifecycleLabels(app: ContainerToolsAppTest): readonly string[] {
  return app.processes.actions().flatMap((action) => {
    if (
      action.type === "start" &&
      action.request.command === "/usr/sbin/gosu"
    ) {
      return [`execute:${action.request.command}`];
    }
    if (action.type === "signal") {
      return [`forward:${action.process.name ?? "unnamed"}:${action.signal}`];
    }
    return [];
  });
}

describe("container PID 1 production application lifecycle", () => {
  test("publishes readiness and shuts down after a scoped clock idle tick", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: {
        SANDBOX_DEBUG: "1",
        SANDBOX_IDLE_TIMEOUT_SECONDS: "1",
      },
    });

    const execution = app.cli.run("entrypoint", "ignored-command");
    const marker = path.join(
      app.roots.container,
      "tmp",
      "sandbox-sessions",
      "invalid-marker",
    );
    fs.writeFileSync(marker, "");
    await app.entrypoint.waitForReady();
    await app.clock.advanceBy(1_000);

    const result = await execution;
    expect(result).toMatchObject({ exitCode: 0, stdout: "" });
    expect(result.stderr).toContain("[container-tools] ready\n");
    expect(result.stderr).toContain("[container-tools] syncing settings\n");
    expect(
      fs.existsSync(path.join(app.roots.container, "tmp", ".sandbox-ready")),
    ).toBe(true);
    expect(app.processes.actions().map((action) => action.type)).toEqual([
      "start",
      "start",
    ]);
  });

  test("uses scoped SIGINT and keeps settings sync failures non-fatal", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_DEBUG: "1" },
    });
    app.settings.givenFinalSyncFailure(new Error("copy failed"));

    const execution = app.cli.run("entrypoint");
    await app.entrypoint.waitForReady();
    app.processes.emitTermination("SIGINT");

    const result = await execution;
    expect(result).toMatchObject({ exitCode: 130, stdout: "" });
    expect(result.stderr).toContain(
      "settings sync failed (non-fatal): copy failed\n",
    );
    expect(app.processes.listenerCount()).toBe(1);
  });
});

describe("container PID 1 real entrypoint startup scenarios", () => {
  test("fails before readiness when copied settings cannot be applied", async () => {
    await using app = await setupContainerToolsAppTest();
    app.settings.givenInitialApplyFailure(new Error("copy source missing"));

    expect(await app.entrypoint.start()).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "copy source missing\n",
    });
    expect(app.entrypoint.isReady()).toBe(false);
    expect(app.settings.initialApplyRequests()).toBe(1);
    expect(app.settings.finalSyncRequests()).toBe(1);
  });

  test("starts minimally, publishes final state and output, then disposes in owner order", async () => {
    const app = await setupContainerToolsAppTest({
      variables: { SANDBOX_DEBUG: "1" },
    });
    const root = app.roots.temporary;

    const execution = app.entrypoint.start("ignored-command");
    await app.entrypoint.waitForReady();
    expect(app.entrypoint.isReady()).toBe(true);
    expect(childEventLabels(app)).toEqual([]);

    expect(await stopReadyEntrypoint(app, execution)).toMatchObject({
      exitCode: 143,
      stdout: "",
    });
    expect(app.signals.subscriptions()).toBe(1);
    expect(app.idle.pendingTicks()).toBe(0);

    await app[Symbol.asyncDispose]();
    expect(app.cleanup.events()).toEqual([
      "cancellation",
      "children-and-signals",
      "timers",
      "sockets",
      "executions",
      "terminal",
      "files-and-root",
    ]);
    expect(app.cleanup.isDisposed()).toBe(true);
    expect(fs.existsSync(root)).toBe(false);
  });

  test("publishes readiness without firewall commands or children when networking is disabled", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_FIREWALL: DISABLED_NETWORK },
    });

    const execution = app.entrypoint.start();
    await app.entrypoint.waitForReady();

    expect(app.entrypoint.isReady()).toBe(true);
    expect(app.processes.requests).toEqual([
      {
        command: "/usr/sbin/gosu",
        args: [
          "sandbox",
          "/usr/local/bin/sandbox-container-tools",
          "settings",
          "apply",
        ],
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(childEventLabels(app)).toEqual([]);
    expect(await stopReadyEntrypoint(app, execution)).toEqual({
      exitCode: 143,
      stdout: "",
      stderr: "",
    });
  });

  test("applies exact host aliases when networking is disabled", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: {
        SANDBOX_FIREWALL: DISABLED_NETWORK,
        SANDBOX_GUEST_HOST_MAPPINGS: JSON.stringify([
          { host: "host.container.internal", address: "192.168.64.1" },
          { host: "host.docker.internal", address: "192.168.64.1" },
        ]),
      },
    });
    app.networkState.givenFile("/etc/hosts", "127.0.0.1 localhost\n");

    const execution = app.entrypoint.start();
    await app.entrypoint.waitForReady();
    expect(app.networkState.readFile("/etc/hosts")).toBe(
      "127.0.0.1 localhost\n192.168.64.1\thost.container.internal\n192.168.64.1\thost.docker.internal\n",
    );
    expect(await stopReadyEntrypoint(app, execution)).toEqual({
      exitCode: 143,
      stdout: "",
      stderr: "",
    });
  });

  test("rejects malformed network policy through the managed entrypoint", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_FIREWALL: "{" },
    });

    expect(await app.entrypoint.start()).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Invalid network bootstrap request: expected valid JSON\n",
    });
    expect(app.entrypoint.isReady()).toBe(false);
    expect(app.processes.requests).toEqual([
      {
        command: "/usr/sbin/gosu",
        args: [
          "sandbox",
          "/usr/local/bin/sandbox-container-tools",
          "settings",
          "sync",
        ],
      },
    ]);
    expect(childEventLabels(app)).toEqual([]);
  });

  test("preserves a restore failure exit code through the managed entrypoint", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_FIREWALL: MANAGED_NETWORK },
    });
    const restore = app.processes.expectStart();
    const execution = app.entrypoint.start();
    await restore.waitForInputEnd();
    restore.emitStderr("permission denied\n");
    restore.exit({ exitCode: 7 });

    expect(await execution).toEqual({
      exitCode: 7,
      stdout: "",
      stderr:
        "/usr/sbin/iptables-restore failed with exit code 7: permission denied\n",
    });
    expect(app.entrypoint.isReady()).toBe(false);
    expect(childEventLabels(app)).toEqual([]);
  });

  test.each([NO_PROXY_NETWORK, MANAGED_NETWORK])(
    "does not start consumers when IPv6 restore fails for %s",
    async (policy) => {
      await using app = await setupContainerToolsAppTest({
        variables: { SANDBOX_FIREWALL: policy },
      });
      app.networkState.givenFile("/etc/resolv.conf", "nameserver 10.0.0.2\n");
      const ipv4 = app.processes.expectStart({
        match: { command: "/usr/sbin/iptables-restore" },
      });
      const ipv6 = app.processes.expectStart({
        match: { command: "/usr/sbin/ip6tables-restore" },
      });
      const execution = app.entrypoint.start();
      await ipv4.waitForInputEnd();
      expect(app.entrypoint.isReady()).toBe(false);
      expect(childEventLabels(app)).toEqual([]);
      expect(
        app.processes.requests.some(
          (request) => request.command === "/usr/sbin/ip6tables-restore",
        ),
      ).toBe(false);
      expect(app.settings.initialApplyRequests()).toBe(0);
      ipv4.exit();
      await ipv6.waitForInputEnd();
      expect(app.settings.initialApplyRequests()).toBe(0);
      expect(app.networkState.readFile("/etc/resolv.conf")).toBe(
        "nameserver 10.0.0.2\n",
      );
      expect(app.entrypoint.isReady()).toBe(false);
      expect(childEventLabels(app)).toEqual([]);
      ipv6.emitStderr("IPv6 rules rejected\n");
      ipv6.exit({ exitCode: 4 });
      expect(await execution).toEqual({
        exitCode: 4,
        stdout: "",
        stderr:
          "/usr/sbin/ip6tables-restore failed with exit code 4: IPv6 rules rejected\n",
      });
      expect(app.entrypoint.isReady()).toBe(false);
      expect(childEventLabels(app)).toEqual([]);
    },
  );

  test("starts the required IDE bridge through the real entrypoint", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { CLAUDE_CODE_SSE_PORT: "12345" },
    });
    const bridge = app.children.givenRequired("ide-bridge");

    const execution = app.entrypoint.start();
    await app.entrypoint.waitForReady();

    expect(bridge.name).toBe("ide-bridge");
    expect(childEventLabels(app)).toEqual(["spawn:ide-bridge"]);
    expect(await stopReadyEntrypoint(app, execution, [bridge])).toEqual({
      exitCode: 143,
      stdout: "",
      stderr: "",
    });
    expect(childEventLabels(app)).toEqual([
      "spawn:ide-bridge",
      "signal:ide-bridge:SIGTERM",
    ]);
  });

  test.each([
    ["Docker", "host.docker.internal"],
    ["Podman", "host.containers.internal"],
    ["Apple container", "host.container.internal"],
  ] as const)(
    "uses the resolved %s host name for the IDE bridge and DNS forwarding",
    async (_runtime, hostAccessName) => {
      await using app = await setupContainerToolsAppTest({
        variables: {
          CLAUDE_CODE_SSE_PORT: "12345",
          SANDBOX_FIREWALL: MANAGED_NETWORK,
          SANDBOX_HOST_ACCESS_NAME: hostAccessName,
        },
      });
      givenSuccessfulFirewallCommands(app);
      app.networkState.givenFile("/etc/resolv.conf", "nameserver 10.0.0.2\n");
      app.networkState.givenFile(
        "/usr/share/squid/errors/en/ERR_ACCESS_DENIED",
        "default",
      );
      app.sockets.listen(DNS_ENDPOINT);
      app.sockets.listen(PROXY_ENDPOINT);
      const bridge = app.children.givenRequired("ide-bridge");
      const dnsmasq = app.children.givenRequired("dnsmasq");
      const squid = app.children.givenRequired("squid");
      const tcpdump = app.children.givenOptional("tcpdump");

      const execution = app.entrypoint.start();
      await app.entrypoint.waitForReady();

      expect(
        app.processes.requests.find((request) => request.name === "ide-bridge")
          ?.args,
      ).toContain(`TCP:${hostAccessName}:12345`);
      expect(
        app.networkState.readFile("/etc/dnsmasq.d/sandbox.conf"),
      ).toContain(`server=/${hostAccessName}/10.0.0.2`);
      expect(
        await stopReadyEntrypoint(app, execution, [
          bridge,
          dnsmasq,
          squid,
          tcpdump,
        ]),
      ).toEqual({ exitCode: 143, stdout: "", stderr: "" });
    },
  );

  test("waits for managed DNS and proxy readiness before publishing proxy state", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_FIREWALL: MANAGED_NETWORK },
    });
    givenSuccessfulFirewallCommands(app);
    app.networkState.givenFile(
      "/etc/resolv.conf",
      "search sandbox\nnameserver 10.0.0.2\n",
    );
    app.networkState.givenFile(
      "/usr/share/squid/errors/en/ERR_ACCESS_DENIED",
      "default",
    );
    app.sockets.close(DNS_ENDPOINT);
    app.sockets.listen(PROXY_ENDPOINT);
    const dnsmasq = app.children.givenRequired("dnsmasq");
    const squid = app.children.givenRequired("squid");
    const tcpdump = app.children.givenOptional("tcpdump");

    const execution = app.entrypoint.start();
    await app.children.waitForSpawn("dnsmasq");
    await app.idle.waitForTick();
    expect(app.entrypoint.isReady()).toBe(false);
    await app.children.waitForSpawn("squid");
    expect(app.sockets.attempts()).toContainEqual(PROXY_ENDPOINT);
    expect(app.settings.initialApplyRequests()).toBe(1);
    expect(app.networkState.readFile("/etc/resolv.conf")).toBe(
      "nameserver 127.0.0.1\n",
    );

    app.sockets.listen(DNS_ENDPOINT);
    await app.idle.advanceToNextTick();
    await app.entrypoint.waitForReady();

    expect(app.sockets.attempts()).toEqual([
      DNS_ENDPOINT,
      PROXY_ENDPOINT,
      DNS_ENDPOINT,
    ]);
    expect(app.networkState.readFile("/etc/resolv.conf")).toBe(
      "nameserver 127.0.0.1\n",
    );
    expect(
      app.files.exists("/etc/ssh/ssh_config.d/50-sandbox-proxy.conf"),
    ).toBe(true);
    expect(childEventLabels(app)).toEqual([
      "spawn:dnsmasq",
      "spawn:squid",
      "spawn:tcpdump",
    ]);
    expect(
      await stopReadyEntrypoint(app, execution, [dnsmasq, squid, tcpdump]),
    ).toEqual({ exitCode: 143, stdout: "", stderr: "" });
    expect(childEventLabels(app).slice(-3)).toEqual([
      "signal:dnsmasq:SIGTERM",
      "signal:squid:SIGTERM",
      "signal:tcpdump:SIGTERM",
    ]);
  });

  test("waits for settings after network readiness and reports a critical process exit", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_FIREWALL: MANAGED_NETWORK },
    });
    const { dnsmasq, squid } = givenProxyServices(app);
    const tcpdump = app.children.givenOptional("tcpdump");
    app.sockets.listen(DNS_ENDPOINT);
    app.sockets.listen(PROXY_ENDPOINT);
    const execution = app.entrypoint.start();
    const settings = givenPendingSettings(app);
    settings.exitOnSignal();
    await app.children.waitForSpawn("tcpdump");
    await settings.waitForStart();
    expect(app.entrypoint.isReady()).toBe(false);
    dnsmasq.exit({ exitCode: 9 });
    await settings.waitForSignal();
    await squid.waitForSignal();
    squid.exit({ signal: "SIGTERM" });
    await tcpdump.waitForSignal();
    tcpdump.exit({ signal: "SIGTERM" });
    expect(await execution).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "dnsmasq exited with code 9\n",
    });
    expect(app.entrypoint.isReady()).toBe(false);
    expect(app.idle.pendingTicks()).toBe(0);
  });

  test("settles both readiness polls when settings fail", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_FIREWALL: MANAGED_NETWORK },
    });
    const { dnsmasq, squid } = givenProxyServices(app);
    const execution = app.entrypoint.start();
    const settings = givenPendingSettings(app);
    await app.children.waitForSpawn("squid");
    await settings.waitForStart();
    expect(app.entrypoint.isReady()).toBe(false);
    settings.exit({ exitCode: 17, stderr: "settings unavailable" });
    await dnsmasq.waitForSignal();
    dnsmasq.exit({ signal: "SIGTERM" });
    await squid.waitForSignal();
    squid.exit({ signal: "SIGTERM" });
    expect(await execution).toEqual({
      exitCode: 17,
      stdout: "",
      stderr: "/usr/sbin/gosu failed with exit code 17: settings unavailable\n",
    });
    expect(app.entrypoint.isReady()).toBe(false);
    expect(app.idle.pendingTicks()).toBe(0);
    expect(childEventLabels(app)).not.toContain("spawn:tcpdump");
  });

  test("does not start the proxy when local DNS setup fails", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_FIREWALL: MANAGED_NETWORK },
    });
    givenProxyServices(app);
    app.files.write("/etc/dnsmasq.d", "not a directory");
    const result = await app.entrypoint.start();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("dnsmasq.d");
    expect(app.entrypoint.isReady()).toBe(false);
    expect(childEventLabels(app)).toEqual([]);
    expect(
      app.processes.requests.some(
        (request) => request.command === "/usr/bin/chown",
      ),
    ).toBe(false);
    expect(app.networkState.readFile("/etc/resolv.conf")).toBe(
      "nameserver 10.0.0.2\n",
    );
    expect(app.idle.pendingTicks()).toBe(0);
  });

  test("settles pending proxy preparation before shutdown after settings fail", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_FIREWALL: MANAGED_NETWORK },
    });
    const { dnsmasq } = givenProxyServices(app);
    app.settings.givenInitialApplyFailure(new Error("settings unavailable"));
    const execution = app.entrypoint.start();
    const ownership = app.processes.expectStart({
      match: { command: "/usr/bin/chown" },
    });
    ownership.exitOnSignal();
    await ownership.waitForStart();
    await ownership.waitForSignal();
    await dnsmasq.waitForSignal();
    dnsmasq.exit({ signal: "SIGTERM" });
    expect(await execution).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "settings unavailable\n",
    });
    expect(
      app.processes.requests.filter(
        (request) => request.command === "/usr/bin/chown",
      ),
    ).toHaveLength(1);
    expect(childEventLabels(app)).toEqual([
      "spawn:dnsmasq",
      "signal:unnamed:SIGTERM",
      "signal:dnsmasq:SIGTERM",
    ]);
    expect(app.idle.pendingTicks()).toBe(0);
  });

  test("waits for delayed settings before publishing readiness", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_FIREWALL: MANAGED_NETWORK },
    });
    const { dnsmasq, squid } = givenProxyServices(app);
    const tcpdump = app.children.givenOptional("tcpdump");
    app.sockets.listen(DNS_ENDPOINT);
    app.sockets.listen(PROXY_ENDPOINT);
    const execution = app.entrypoint.start();
    const settings = givenPendingSettings(app);
    await app.children.waitForSpawn("tcpdump");
    await settings.waitForStart();
    expect(app.entrypoint.isReady()).toBe(false);
    settings.exit();
    await app.entrypoint.waitForReady();
    expect(
      await stopReadyEntrypoint(app, execution, [dnsmasq, squid, tcpdump]),
    ).toEqual({
      exitCode: 143,
      stdout: "",
      stderr: "",
    });
  });

  test("settles settings and both readiness polls after SIGINT", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_FIREWALL: MANAGED_NETWORK },
    });
    const { dnsmasq, squid } = givenProxyServices(app);
    const execution = app.entrypoint.start();
    const settings = givenPendingSettings(app);
    settings.exitOnSignal();
    await app.children.waitForSpawn("squid");
    await settings.waitForStart();
    app.signals.send("SIGINT");
    await settings.waitForSignal();
    await dnsmasq.waitForSignal();
    dnsmasq.exit({ signal: "SIGINT" });
    await squid.waitForSignal();
    squid.exit({ signal: "SIGINT" });
    expect(await execution).toEqual({ exitCode: 130, stdout: "", stderr: "" });
    expect(app.entrypoint.isReady()).toBe(false);
    expect(app.idle.pendingTicks()).toBe(0);
    expect(childEventLabels(app)).not.toContain("spawn:tcpdump");
  });

  test("cancels the sibling readiness poll when DNS exits", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_FIREWALL: MANAGED_NETWORK },
    });
    const { dnsmasq, squid } = givenProxyServices(app);
    const execution = app.entrypoint.start();
    await app.children.waitForSpawn("squid");
    dnsmasq.exit({ exitCode: 9 });
    await squid.waitForSignal();
    squid.exit({ signal: "SIGTERM" });
    expect((await execution).exitCode).toBe(1);
    expect(app.entrypoint.isReady()).toBe(false);
    expect(app.idle.pendingTicks()).toBe(0);
    expect(childEventLabels(app)).not.toContain("spawn:tcpdump");
  });

  test("isolates concurrent managed network startup policies", async () => {
    await using first = await setupContainerToolsAppTest({
      variables: { SANDBOX_FIREWALL: MANAGED_NETWORK },
    });
    await using second = await setupContainerToolsAppTest({
      variables: {
        SANDBOX_FIREWALL: MANAGED_NETWORK.replace(
          "example.com",
          "second.example",
        ),
      },
    });
    const scopes = [first, second] as const;
    const children = scopes.map((app) => {
      givenSuccessfulFirewallCommands(app);
      app.networkState.givenFile("/etc/resolv.conf", "nameserver 10.0.0.2\n");
      app.networkState.givenFile(
        "/usr/share/squid/errors/en/ERR_ACCESS_DENIED",
        "default",
      );
      app.sockets.listen(DNS_ENDPOINT);
      app.sockets.listen(PROXY_ENDPOINT);
      return [
        app.children.givenRequired("dnsmasq"),
        app.children.givenRequired("squid"),
        app.children.givenOptional("tcpdump"),
      ] as const;
    });

    const executions = scopes.map((app) => app.entrypoint.start());
    await Promise.all(scopes.map((app) => app.entrypoint.waitForReady()));

    expect(
      first.networkState.readFile("/var/run/proxy-allowed-domains-0.txt"),
    ).toBe("example.com\n");
    expect(
      second.networkState.readFile("/var/run/proxy-allowed-domains-0.txt"),
    ).toBe("second.example\n");
    expect(first.sockets.attempts()).toEqual([DNS_ENDPOINT, PROXY_ENDPOINT]);
    expect(second.sockets.attempts()).toEqual([DNS_ENDPOINT, PROXY_ENDPOINT]);

    const results = await Promise.all(
      scopes.map((app, index) =>
        stopReadyEntrypoint(app, executions[index] as (typeof executions)[0], [
          ...(children[index] as (typeof children)[0]),
        ]),
      ),
    );
    expect(results).toEqual([
      { exitCode: 143, stdout: "", stderr: "" },
      { exitCode: 143, stdout: "", stderr: "" },
    ]);
  });

  test("starts managed no-proxy networking with generic host mappings", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: {
        SANDBOX_FIREWALL: NO_PROXY_NETWORK,
        SANDBOX_GUEST_HOST_MAPPINGS: JSON.stringify([
          { host: "host.container.internal", address: "192.168.64.1" },
        ]),
      },
    });
    app.networkState.givenFile("/etc/hosts", "127.0.0.1 localhost\n");
    givenSuccessfulFirewallCommands(app);
    const tcpdump = app.children.givenOptional("tcpdump");

    const execution = app.entrypoint.start();
    await app.entrypoint.waitForReady();

    expect(app.entrypoint.isReady()).toBe(true);
    expect(app.sockets.attempts()).toEqual([]);
    expect(app.files.exists("/etc/dnsmasq.d/sandbox.conf")).toBe(false);
    expect(app.files.exists("/etc/squid/squid.conf")).toBe(false);
    expect(
      app.files.exists("/etc/ssh/ssh_config.d/50-sandbox-proxy.conf"),
    ).toBe(false);
    expect(app.networkState.readFile("/etc/hosts")).toContain(
      "192.168.64.1\thost.container.internal",
    );
    expect(childEventLabels(app)).toEqual(["spawn:tcpdump"]);
    expect(await stopReadyEntrypoint(app, execution, [tcpdump])).toEqual({
      exitCode: 143,
      stdout: "",
      stderr: "",
    });
  });

  test("does not start an early guest consumer before network readiness", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: {
        CLAUDE_CODE_SSE_PORT: "12345",
        SANDBOX_FIREWALL: MANAGED_NETWORK,
      },
    });
    givenSuccessfulFirewallCommands(app);
    app.networkState.givenFile("/etc/resolv.conf", "nameserver 10.0.0.2\n");
    app.sockets.close(DNS_ENDPOINT);
    app.sockets.listen(PROXY_ENDPOINT);
    const bridge = app.children.givenRequired("ide-bridge");
    const dnsmasq = app.children.givenRequired("dnsmasq");
    const squid = app.children.givenRequired("squid");
    const tcpdump = app.children.givenOptional("tcpdump");

    const execution = app.entrypoint.start();
    await app.children.waitForSpawn("dnsmasq");
    await app.idle.waitForTick();
    await app.children.waitForSpawn("squid");
    expect(childEventLabels(app)).toEqual(["spawn:dnsmasq", "spawn:squid"]);

    app.sockets.listen(DNS_ENDPOINT);
    await app.idle.advanceToNextTick();
    await app.entrypoint.waitForReady();
    expect(childEventLabels(app)).toEqual([
      "spawn:dnsmasq",
      "spawn:squid",
      "spawn:tcpdump",
      "spawn:ide-bridge",
    ]);
    expect(
      await stopReadyEntrypoint(app, execution, [
        bridge,
        dnsmasq,
        squid,
        tcpdump,
      ]),
    ).toEqual({ exitCode: 143, stdout: "", stderr: "" });
  });

  test("reports a required child failure after readiness", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { CLAUDE_CODE_SSE_PORT: "12345" },
    });
    const bridge = app.children.givenRequired("ide-bridge");

    const execution = app.entrypoint.start();
    await app.entrypoint.waitForReady();
    bridge.exit({ exitCode: 29, stderr: "bridge stopped" });

    expect(await execution).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "ide-bridge exited with code 29\n",
    });
    expect(app.entrypoint.isReady()).toBe(true);
    expect(childEventLabels(app)).toEqual(["spawn:ide-bridge"]);
    expect(app.signals.subscriptions()).toBe(1);
  });

  test("keeps the container running when managed tcpdump exits after readiness", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_FIREWALL: NO_PROXY_NETWORK },
    });
    givenSuccessfulFirewallCommands(app);
    const tcpdump = app.children.givenOptional("tcpdump");

    const execution = app.entrypoint.start();
    await app.entrypoint.waitForReady();
    tcpdump.exit({ exitCode: 1, stderr: "NFLOG is unavailable" });

    expect(app.entrypoint.isReady()).toBe(true);
    expect(await stopReadyEntrypoint(app, execution)).toEqual({
      exitCode: 143,
      stdout: "",
      stderr: "[container-tools] ⚠ tcpdump exited with code 1\n",
    });
    expect(childEventLabels(app)).toEqual(["spawn:tcpdump"]);
  });

  test("cleans a managed child when network startup fails", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_FIREWALL: MANAGED_NETWORK },
    });
    givenSuccessfulFirewallCommands(app);
    app.networkState.givenFile("/etc/resolv.conf", "nameserver 10.0.0.2\n");
    app.sockets.fail(DNS_ENDPOINT, new Error("DNS readiness failed"));
    const dnsmasq = app.children.givenRequired("dnsmasq");

    const execution = app.entrypoint.start();
    await app.children.waitForSpawn("dnsmasq");
    await dnsmasq.waitForSignal();
    dnsmasq.exit({ signal: "SIGTERM" });

    expect(await execution).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "DNS readiness failed\n",
    });
    expect(app.entrypoint.isReady()).toBe(false);
    expect(app.sockets.attempts()).toEqual([DNS_ENDPOINT]);
    expect(childEventLabels(app)).toEqual([
      "spawn:dnsmasq",
      "signal:dnsmasq:SIGTERM",
    ]);
    expect(app.children.pending()).toBe(0);
  });

  test("cancels an in-progress network startup command on SIGINT", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_FIREWALL: MANAGED_NETWORK },
    });
    app.processes.expectStart({
      match: { command: "/usr/sbin/iptables-restore" },
      rejectOnAbort: true,
    });

    const execution = app.entrypoint.start();
    while (
      !app.processes.requests.some(
        (request) => request.command === "/usr/sbin/iptables-restore",
      )
    ) {
      await Promise.resolve();
    }
    app.signals.send("SIGINT");

    expect(await execution).toEqual({ exitCode: 130, stdout: "", stderr: "" });
    expect(
      app.processes.requests.find(
        (request) => request.command === "/usr/sbin/iptables-restore",
      ),
    ).toEqual({
      command: "/usr/sbin/iptables-restore",
      args: ["--noflush"],
      stdio: "stream",
      signal: expect.any(AbortSignal),
    });
    expect(app.entrypoint.isReady()).toBe(false);
    expect(childEventLabels(app)).toEqual([]);
  });

  for (const { signal, exitCode } of [
    { signal: "SIGINT", exitCode: 130 },
    { signal: "SIGTERM", exitCode: 143 },
  ] as const) {
    test(`returns ${exitCode} for ${signal} during managed network readiness after supervisor cleanup`, async () => {
      await using app = await setupContainerToolsAppTest({
        variables: { SANDBOX_FIREWALL: MANAGED_NETWORK },
      });
      givenSuccessfulFirewallCommands(app);
      app.networkState.givenFile("/etc/resolv.conf", "nameserver 10.0.0.2\n");
      app.sockets.close(DNS_ENDPOINT);
      const dnsmasq = app.children.givenRequired("dnsmasq");

      const execution = app.entrypoint.start();
      const settings = givenPendingSettings(app);
      await app.children.waitForSpawn("dnsmasq");
      await app.idle.waitForTick();
      await settings.waitForStart();
      settings.exit();
      app.signals.send(signal);
      await expect(dnsmasq.waitForSignal()).resolves.toBe(signal);
      dnsmasq.exit({ signal });

      expect(await execution).toEqual({ exitCode, stdout: "", stderr: "" });
      expect(app.entrypoint.isReady()).toBe(false);
      expect(app.sockets.attempts()).toEqual([DNS_ENDPOINT]);
      expect(app.idle.pendingTicks()).toBe(0);
      expect(dnsmasq.signals).toEqual([signal]);
      expect(
        app.processes.requests.find(
          (request) => "name" in request && request.name === "dnsmasq",
        ),
      ).toEqual(
        expect.not.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(childEventLabels(app)).toEqual([
        "spawn:dnsmasq",
        `signal:dnsmasq:${signal}`,
      ]);
      expect(app.children.pending()).toBe(0);
      expect(finalLifecycleLabels(app)).toEqual([
        "execute:/usr/sbin/gosu",
        `forward:dnsmasq:${signal}`,
        "execute:/usr/sbin/gosu",
      ]);
    });
  }
});

describe("container PID 1 real entrypoint shutdown scenarios", () => {
  for (const { signal, exitCode } of [
    { signal: "SIGINT", exitCode: 130 },
    { signal: "SIGTERM", exitCode: 143 },
  ] as const) {
    test(`returns ${exitCode} and forwards ${signal} to every managed child`, async () => {
      await using app = await setupContainerToolsAppTest({
        variables: { CLAUDE_CODE_SSE_PORT: "12345" },
      });
      const bridge = app.children.givenRequired("ide-bridge");
      const execution = app.entrypoint.start();
      await app.entrypoint.waitForReady();

      app.signals.send(signal);
      await expect(bridge.waitForSignal()).resolves.toBe(signal);
      bridge.exit({ signal });

      expect(await execution).toEqual({ exitCode, stdout: "", stderr: "" });
      expect(bridge.signals).toEqual([signal]);
      expect(finalLifecycleLabels(app)).toEqual([
        "execute:/usr/sbin/gosu",
        `forward:ide-bridge:${signal}`,
        "execute:/usr/sbin/gosu",
      ]);
    });
  }

  test("terminates active exec sessions before final settings sync", async () => {
    await using app = await setupContainerToolsAppTest();
    const execution = app.entrypoint.start();
    await app.entrypoint.waitForReady();
    app.sessions.givenActive(41);

    app.signals.send("SIGTERM");

    expect(await execution).toEqual({ exitCode: 143, stdout: "", stderr: "" });
    const lifecycleActions = app.processes.actions();
    const sessionSignalIndex = lifecycleActions.findIndex(
      (action) => action.type === "signal" && action.process.pid === 41,
    );
    const settingsSyncIndex = lifecycleActions.findIndex(
      (action) =>
        action.type === "start" &&
        action.request.command === "/usr/sbin/gosu" &&
        action.request.args?.at(-1) === "sync",
    );
    expect(sessionSignalIndex).toBeGreaterThanOrEqual(0);
    expect(settingsSyncIndex).toBeGreaterThan(sessionSignalIndex);
    expect(app.settings.finalSyncRequests()).toBe(1);
  });

  test("does not idle-shutdown a container that has never had sessions", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_IDLE_TIMEOUT_SECONDS: "1" },
    });
    const execution = app.entrypoint.start();
    await app.entrypoint.waitForReady();

    await advanceIdleTicks(app, 3);
    expect(app.entrypoint.isReady()).toBe(true);
    expect(app.signals.subscriptions()).toBe(1);
    expect(app.settings.finalSyncRequests()).toBe(0);

    expect(await stopReadyEntrypoint(app, execution)).toEqual({
      exitCode: 143,
      stdout: "",
      stderr: "",
    });
  });

  test("keeps active sessions alive and starts the idle timeout after their marker becomes stale", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_IDLE_TIMEOUT_SECONDS: "2" },
    });
    const execution = app.entrypoint.start();
    await app.entrypoint.waitForReady();
    app.sessions.givenActive(41);

    await advanceIdleTicks(app, 3);
    expect(app.sessions.markerExists(41)).toBe(true);
    expect(app.settings.finalSyncRequests()).toBe(0);

    app.sessions.end(41);
    await advanceIdleTicks(app, 1);
    expect(app.sessions.markerExists(41)).toBe(false);
    expect(app.settings.finalSyncRequests()).toBe(0);
    await advanceIdleTicks(app, 2);

    expect(await execution).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(app.settings.finalSyncRequests()).toBe(1);
  });

  test("treats a stale session marker as activity for one idle period and removes it", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_IDLE_TIMEOUT_SECONDS: "1" },
    });
    const execution = app.entrypoint.start();
    await app.entrypoint.waitForReady();
    app.sessions.givenMarker("stale-session");

    await advanceIdleTicks(app, 1);
    expect(app.sessions.markerExists("stale-session")).toBe(false);
    expect(app.settings.finalSyncRequests()).toBe(0);
    await advanceIdleTicks(app, 1);

    expect(await execution).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("rechecks final activity before a zero-timeout shutdown", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_IDLE_TIMEOUT_SECONDS: "0" },
    });
    const execution = app.entrypoint.start();
    await app.entrypoint.waitForReady();
    app.sessions.givenActive(52);

    await advanceIdleTicks(app, 1);
    expect(app.signals.subscriptions()).toBe(1);
    expect(app.settings.finalSyncRequests()).toBe(0);

    app.sessions.end(52);
    await advanceIdleTicks(app, 1);
    expect(await execution).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(app.sessions.markerExists(52)).toBe(false);
  });

  test("forwards successful final settings synchronization output", async () => {
    await using app = await setupContainerToolsAppTest();
    app.settings.givenFinalSync({
      exitCode: 0,
      stdout: "→ Synced ~/.claude/settings.json to host\n",
      stderr: "",
    });
    const execution = app.entrypoint.start();
    await app.entrypoint.waitForReady();

    app.signals.send("SIGTERM");

    expect(await execution).toEqual({
      exitCode: 143,
      stdout: "→ Synced ~/.claude/settings.json to host\n",
      stderr: "",
    });
    expect(app.settings.finalSyncRequests()).toBe(1);
  });

  test("keeps final settings synchronization failure non-fatal", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_DEBUG: "1" },
    });
    app.settings.givenFinalSyncFailure(
      new Error("settings volume unavailable"),
    );
    const execution = app.entrypoint.start();
    await app.entrypoint.waitForReady();

    app.signals.send("SIGTERM");

    expect(await execution).toEqual({
      exitCode: 143,
      stdout: "",
      stderr:
        "[container-tools] entrypoint starting\n" +
        "[container-tools] container state prepared\n" +
        "[container-tools] mount ownership repaired\n" +
        "[container-tools] copied settings applied\n" +
        "[container-tools] ready\n" +
        "[container-tools] syncing settings\n" +
        "[container-tools] settings sync failed (non-fatal): settings volume unavailable\n",
    });
    expect(app.settings.finalSyncRequests()).toBe(1);
  });

  for (const { signal, exitCode } of [
    { signal: "SIGINT", exitCode: 130 },
    { signal: "SIGTERM", exitCode: 143 },
  ] as const) {
    test(`preserves ${exitCode} for ${signal} after bounded managed-child cleanup fails`, async () => {
      await using app = await setupContainerToolsAppTest({
        variables: {
          CLAUDE_CODE_SSE_PORT: "12345",
          SANDBOX_DEBUG: "1",
        },
      });
      const bridge = app.children.givenRequired("ide-bridge");
      app.settings.givenFinalSync({
        exitCode: 0,
        stdout: "final sync\n",
        stderr: "",
      });
      const execution = app.entrypoint.start();
      await app.entrypoint.waitForReady();

      app.signals.send(signal);
      await expect(bridge.waitForSignal()).resolves.toBe(signal);
      await app.idle.waitForTick();
      await app.idle.advanceToNextTick();
      await waitForChildSignal(bridge, "SIGKILL");
      await app.idle.waitForTick();
      await app.idle.advanceToNextTick();

      expect(await execution).toEqual({
        exitCode,
        stdout: "final sync\n",
        stderr:
          "[container-tools] entrypoint starting\n" +
          "[container-tools] container state prepared\n" +
          "[container-tools] mount ownership repaired\n" +
          "[container-tools] copied settings applied\n" +
          "[container-tools] ready\n" +
          "[container-tools] ✗ Failed to terminate managed processes after SIGKILL: ide-bridge (pid 1001)\n" +
          "[container-tools] syncing settings\n",
      });
      expect(bridge.signals).toEqual([signal, "SIGKILL"]);
      expect(finalLifecycleLabels(app)).toEqual([
        "execute:/usr/sbin/gosu",
        `forward:ide-bridge:${signal}`,
        "forward:ide-bridge:SIGKILL",
        "execute:/usr/sbin/gosu",
      ]);
      expect(
        app.children.events().some((action) => action.type === "unref"),
      ).toBe(true);
      expect(app.settings.finalSyncRequests()).toBe(1);
    });
  }

  test("reports managed-child cleanup failure during idle shutdown", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: {
        CLAUDE_CODE_SSE_PORT: "12345",
        SANDBOX_IDLE_TIMEOUT_SECONDS: "0",
      },
    });
    const bridge = app.children.givenRequired("ide-bridge");
    const execution = app.entrypoint.start();
    await app.entrypoint.waitForReady();
    app.sessions.givenMarker("stale-session");

    await advanceIdleTicks(app, 1);
    await waitForChildSignal(bridge, "SIGTERM");
    await app.idle.waitForTick();
    await app.idle.advanceToNextTick();
    await waitForChildSignal(bridge, "SIGKILL");
    await app.idle.waitForTick();
    await app.idle.advanceToNextTick();

    expect(await execution).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "Failed to terminate managed processes after SIGKILL: ide-bridge (pid 1001)\n",
    });
    expect(bridge.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(
      app.children.events().some((action) => action.type === "unref"),
    ).toBe(true);
    expect(app.settings.finalSyncRequests()).toBe(1);
  });

  for (const invalidTimeout of ["invalid", "-1", "Infinity"]) {
    test(`rejects invalid idle timeout ${invalidTimeout} after readiness and still runs final sync`, async () => {
      await using app = await setupContainerToolsAppTest({
        variables: {
          SANDBOX_IDLE_TIMEOUT_SECONDS: invalidTimeout,
          SANDBOX_DEBUG: "1",
        },
      });

      const result = await app.entrypoint.start();
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "[container-tools] entrypoint starting\n" +
          "[container-tools] container state prepared\n" +
          "[container-tools] mount ownership repaired\n" +
          "[container-tools] copied settings applied\n" +
          "[container-tools] ready\n" +
          "[container-tools] syncing settings\n",
      );
      expect(result.stderr).toContain(
        `[container-tools] Error: Invalid SANDBOX_IDLE_TIMEOUT_SECONDS: ${invalidTimeout}`,
      );
      expect(result.stderr).toEndWith(
        `Invalid SANDBOX_IDLE_TIMEOUT_SECONDS: ${invalidTimeout}\n`,
      );
      expect(app.entrypoint.isReady()).toBe(true);
      expect(app.settings.finalSyncRequests()).toBe(1);
    });
  }
});
