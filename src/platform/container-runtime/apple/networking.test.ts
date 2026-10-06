import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { createSystemClock, provideClock } from "#platform/clock/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import type { RuntimeExecutor } from "../executor.js";
import { AppleNetworking, acquireAppleBuilderLock } from "./networking.js";

const NETWORK = JSON.stringify([
  {
    id: "default",
    configuration: { name: "default", creationDate: "first" },
    status: {
      ipv4Gateway: "192.168.64.1",
      ipv4Subnet: "192.168.64.0/24",
      ipv6Subnet: "fd00::/64",
    },
  },
]);
const IFCONFIG = `bridge100: flags=8a63<UP,RUNNING> mtu 1500
\tinet 192.168.64.1 netmask 0xffffff00
\tinet6 fe80::1234%bridge100 prefixlen 64
`;
const GUEST_NETWORK = `1: lo inet 127.0.0.1/8 scope host lo
2: ens4 inet 192.168.64.8/24 scope global ens4
192.168.64.0/24 dev ens4 scope link src 192.168.64.8
`;
const RESOLVER = "fe80::1234%ens4";
const HOST_RESOLVER = "192.0.2.100";
const HOST_DNS = `DNS configuration

resolver #1
  nameserver[0] : ${HOST_RESOLVER}
  nameserver[1] : 192.0.2.101
  flags : Request A records, Request AAAA records

resolver #2
  domain : local
  options : mdns

DNS configuration (for scoped queries)

resolver #1
  nameserver[0] : 203.0.113.1
  if_index : 14 (en0)
`;

interface CommandEvent {
  readonly command: string;
  readonly args: readonly string[];
}

function createExecutor(
  options: {
    readonly network?: string;
    readonly networks?: readonly string[];
    readonly builderStates?: readonly (
      | "absent"
      | "matching"
      | "host"
      | "mismatched"
      | "stopped"
    )[];
    readonly bridge?: string | readonly string[];
    readonly hostDns?: string | readonly string[];
    readonly guest?: string;
    readonly runningContainers?: readonly string[];
  } = {},
): { readonly exec: RuntimeExecutor; readonly events: CommandEvent[] } {
  const events: CommandEvent[] = [];
  let builderStatus = 0;
  let bridgeStatus = 0;
  let networkStatus = 0;
  let hostDnsStatus = 0;
  const exec: RuntimeExecutor = async (command, args = []) => {
    events.push({ command, args });
    if (
      command === "container" &&
      args[0] === "network" &&
      args[1] === "list"
    ) {
      const networks = options.networks ?? [options.network ?? NETWORK];
      return (
        networks[Math.min(networkStatus++, networks.length - 1)] ?? NETWORK
      );
    }
    if (
      command === "container" &&
      args[0] === "network" &&
      args[1] === "create"
    ) {
      return "";
    }
    if (command === "container" && args[0] === "run") return "";
    if (command === "container" && args[0] === "list") {
      return JSON.stringify(
        (options.runningContainers ?? []).map((id) => ({
          id,
          configuration: { id },
          status: { state: "running" },
        })),
      );
    }
    if (command === "scutil") {
      const configurations = Array.isArray(options.hostDns)
        ? options.hostDns
        : [options.hostDns ?? HOST_DNS];
      return (
        configurations[Math.min(hostDnsStatus++, configurations.length - 1)] ??
        HOST_DNS
      );
    }
    if (command === "ifconfig") {
      const bridges = Array.isArray(options.bridge)
        ? options.bridge
        : [options.bridge ?? IFCONFIG];
      return bridges[Math.min(bridgeStatus++, bridges.length - 1)] ?? IFCONFIG;
    }
    if (command === "container" && args[0] === "exec") {
      return options.guest ?? GUEST_NETWORK;
    }
    if (command === "container" && args[0] === "delete") return "";
    if (
      command === "container" &&
      args[0] === "builder" &&
      args[1] === "start"
    ) {
      return "";
    }
    if (
      command === "container" &&
      args[0] === "builder" &&
      args[1] === "status"
    ) {
      const states = options.builderStates ?? ["absent"];
      const state =
        states[Math.min(builderStatus++, states.length - 1)] ?? "absent";
      if (state === "absent") return "[]";
      return JSON.stringify([
        {
          id: "buildkit",
          configuration: {
            dns: {
              nameservers:
                state === "host"
                  ? [HOST_RESOLVER]
                  : state === "mismatched"
                    ? ["192.0.2.53"]
                    : [RESOLVER],
            },
            networks: [{ network: "default" }],
          },
          status: { state: state === "stopped" ? "stopped" : "running" },
        },
      ]);
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  return { exec, events };
}

function count(
  events: readonly CommandEvent[],
  args: readonly string[],
): number {
  return events.filter(
    (event) =>
      JSON.stringify(event.args.slice(0, args.length)) === JSON.stringify(args),
  ).length;
}

async function withHostEnvironment<T>(
  callback: (dataHomeDirectory: string) => Promise<T>,
): Promise<T> {
  const dataHomeDirectory = createTestDir("apple-network");
  using _cleanup = {
    [Symbol.dispose]: () => cleanupTestDir(dataHomeDirectory),
  };
  return await runWithTestLogger(() => callback(dataHomeDirectory), {
    clock: createSystemClock(),
    currentWorkingDirectory: "/project",
    homeDirectory: "/home/test",
    variables: { XDG_DATA_HOME: dataHomeDirectory },
    platform: "darwin",
  });
}

describe("Apple private networking owner", () => {
  test("uses the inspected gateway without changing the resolver in default mode", async () => {
    const harness = createExecutor();
    const networking = new AppleNetworking(harness.exec, { dns: "default" });
    await using plan = await networking.prepareRun();

    expect(plan.dns).toBeUndefined();
    expect(plan.networkName).toBe("default");
    expect(
      JSON.parse(plan.environment.SANDBOX_GUEST_HOST_MAPPINGS ?? ""),
    ).toEqual([
      { host: "host.container.internal", address: "192.168.64.1" },
      { host: "host.docker.internal", address: "192.168.64.1" },
    ]);
    expect(count(harness.events, ["run"])).toBe(0);
    await networking.prepareBuild();
    expect(count(harness.events, ["builder"])).toBe(0);
  });

  test.each([
    HOST_DNS,
    HOST_DNS.replace("  flags :", "  if_index : 14 (en0)\n  flags :"),
  ])(
    "uses primary host DNS without a bridge proxy or helper",
    async (hostDns) => {
      const harness = createExecutor({ hostDns });
      const networking = new AppleNetworking(harness.exec, { dns: "host" });

      await using plan = await networking.prepareRun();

      expect(plan.dns).toBe(HOST_RESOLVER);
      expect(plan.networkName).toBe("default");
      expect(count(harness.events, ["run"])).toBe(0);
      expect(count(harness.events, ["-a"])).toBe(0);
      expect(
        harness.events.map(({ command, args }) => [command, ...args]),
      ).toEqual([
        ["container", "network", "list", "--format", "json"],
        ["scutil", "--dns"],
      ]);
    },
  );

  test("revalidates host DNS for compatibility and later runs", async () => {
    const changed = HOST_DNS.replace(HOST_RESOLVER, "198.51.100.100");
    const harness = createExecutor({ hostDns: [HOST_DNS, changed, changed] });
    const networking = new AppleNetworking(harness.exec, { dns: "host" });

    const first = await networking.compatibilityIdentity();
    const second = await networking.compatibilityIdentity();
    await using plan = await networking.prepareRun();

    expect(second).not.toBe(first);
    expect(plan.dns).toBe("198.51.100.100");
    expect(count(harness.events, ["run"])).toBe(0);
  });

  test("rejects host DNS that a guest cannot use instead of selecting scoped or public DNS", async () => {
    const outputs = [
      "No DNS configuration available",
      HOST_DNS.replace(
        "resolver #1\n",
        "resolver #1\n  domain : vpn.example\n",
      ),
      HOST_DNS.slice(
        HOST_DNS.indexOf("DNS configuration (for scoped queries)"),
      ),
      HOST_DNS.replace("  flags :", "  flags : Scoped,"),
      HOST_DNS.replace(/192\.0\.2\.(?:100|101)/gu, "127.0.0.1"),
      HOST_DNS.replace(/192\.0\.2\.(?:100|101)/gu, "::1"),
      HOST_DNS.replace(/192\.0\.2\.(?:100|101)/gu, "fe80::1234%en0"),
    ];
    for (const hostDns of outputs) {
      const harness = createExecutor({ hostDns });
      await expect(
        new AppleNetworking(harness.exec, { dns: "host" }).prepareRun(),
      ).rejects.toThrow("no guest-reachable primary DNS server");
      expect(count(harness.events, ["run"])).toBe(0);
    }
  });

  test.each([
    ["127.0.0.53", "192.0.2.101"],
    ["2001:db8::53", "2001:db8::53"],
  ])("selects guest-usable host DNS from %s", async (first, expected) => {
    const harness = createExecutor({
      hostDns: HOST_DNS.replace(HOST_RESOLVER, first),
    });
    await using plan = await new AppleNetworking(harness.exec, {
      dns: "host",
    }).prepareRun();
    expect(plan.dns).toBe(expected);
  });

  test("removes a cold host-mode helper when resolver discovery fails", async () => {
    const harness = createExecutor({
      networks: ["[]", "[]", NETWORK],
      hostDns: "No DNS configuration available",
    });
    await expect(
      new AppleNetworking(harness.exec, { dns: "host" }).prepareRun(),
    ).rejects.toThrow("no guest-reachable primary DNS server");
    expect(count(harness.events, ["delete"])).toBe(1);
  });

  test("prepares host DNS with the shared builder workflow", async () => {
    await withHostEnvironment(async () => {
      const harness = createExecutor({ builderStates: ["absent", "host"] });
      await new AppleNetworking(harness.exec, { dns: "host" }).prepareBuild();
      expect(
        harness.events.find(
          ({ args }) => args[0] === "builder" && args[1] === "start",
        )?.args,
      ).toEqual(["builder", "start", "--dns", HOST_RESOLVER]);
      expect(count(harness.events, ["run"])).toBe(0);

      const active = createExecutor({ builderStates: ["mismatched"] });
      await expect(
        new AppleNetworking(active.exec, { dns: "host" }).prepareBuild(),
      ).rejects.toThrow("active with different DNS settings");
      expect(count(active.events, ["builder", "start"])).toBe(0);
    });
  });

  test("selects a scoped helper when no active runtime resource can discover the resolver", async () => {
    const harness = createExecutor({
      builderStates: ["absent"],
      runningContainers: [],
    });
    const networking = new AppleNetworking(harness.exec, { dns: "host-ipv6" });
    {
      await using plan = await networking.prepareRun();
      expect(plan.dns).toBe(RESOLVER);
      expect(count(harness.events, ["delete"])).toBe(0);
    }
    expect(count(harness.events, ["delete"])).toBe(1);
    expect(harness.events.map(({ args }) => args[0])).toEqual([
      "network",
      "-a",
      "builder",
      "list",
      "run",
      "exec",
      "delete",
    ]);
    expect(
      harness.events.find((event) => event.args[0] === "run")?.args,
    ).toContain("default");
  });

  test("changes host IPv6 compatibility when the effective bridge resolver changes", async () => {
    const changedBridge = IFCONFIG.replace("fe80::1234", "fe80::5678");
    const harness = createExecutor({ bridge: [IFCONFIG, changedBridge] });
    const networking = new AppleNetworking(harness.exec, { dns: "host-ipv6" });

    const first = await networking.compatibilityIdentity();
    const second = await networking.compatibilityIdentity();

    expect(second).not.toBe(first);
    expect(first).not.toContain("fe80::1234");
    expect(second).not.toContain("fe80::5678");
    expect(count(harness.events, ["run"])).toBe(0);
  });

  test("keeps default compatibility independent from bridge resolver state", async () => {
    const changedBridge = IFCONFIG.replace("fe80::1234", "fe80::5678");
    const harness = createExecutor({ bridge: [IFCONFIG, changedBridge] });
    const networking = new AppleNetworking(harness.exec, { dns: "default" });

    const first = await networking.compatibilityIdentity();
    const second = await networking.compatibilityIdentity();

    expect(second).toBe(first);
    expect(count(harness.events, ["-a"])).toBe(0);
  });

  test("reuses an active builder without creating a helper", async () => {
    const harness = createExecutor({ builderStates: ["matching"] });
    const networking = new AppleNetworking(harness.exec, { dns: "host-ipv6" });

    await using plan = await networking.prepareRun();

    expect(plan.dns).toBe(RESOLVER);
    expect(count(harness.events, ["run"])).toBe(0);
    expect(count(harness.events, ["builder", "status"])).toBe(1);
  });

  test("reuses a running guest before creating a helper", async () => {
    const harness = createExecutor({ runningContainers: ["existing"] });
    const networking = new AppleNetworking(harness.exec, { dns: "host-ipv6" });

    await using plan = await networking.prepareRun();

    expect(plan.dns).toBe(RESOLVER);
    expect(count(harness.events, ["run"])).toBe(0);
    expect(
      harness.events.some(
        ({ args }) => args[0] === "exec" && args[1] === "existing",
      ),
    ).toBe(true);
  });

  test("rediscovers cold resolver state after helper completion and network recreation", async () => {
    let networkCalls = 0;
    const harness = createExecutor();
    const changed = NETWORK.replace(
      '"creationDate":"first"',
      '"creationDate":"second"',
    );
    const exec: RuntimeExecutor = (command, args, options) => {
      if (command === "container" && args?.[0] === "network") {
        networkCalls++;
        return Promise.resolve(networkCalls < 3 ? NETWORK : changed);
      }
      return harness.exec(command, args, options);
    };
    const networking = new AppleNetworking(exec, { dns: "host-ipv6" });
    await using first = await networking.prepareRun();
    await using second = await networking.prepareRun();
    expect(first.dns).toBe(second.dns);
    expect(count(harness.events, ["run"])).toBe(2);
    await using third = await networking.prepareRun();
    expect(third.dns).toBe(RESOLVER);
    expect(count(harness.events, ["run"])).toBe(3);
  });

  test("revalidates a changed bridge resolver without relying on network identity", async () => {
    const changedBridge = IFCONFIG.replace("fe80::1234", "fe80::5678");
    const harness = createExecutor({ bridge: [IFCONFIG, changedBridge] });
    const networking = new AppleNetworking(harness.exec, { dns: "host-ipv6" });

    {
      await using first = await networking.prepareRun();
      expect(first.dns).toBe("fe80::1234%ens4");
    }
    await using second = await networking.prepareRun();

    expect(second.dns).toBe("fe80::5678%ens4");
    expect(count(harness.events, ["run"])).toBe(2);
  });

  test("removes the helper when bridge or guest-interface discovery fails", async () => {
    const missingBridge = createExecutor({
      bridge: "bridge0: flags=UP\n\tinet 10.0.0.1 netmask 0xffffff00\n",
    });
    const clock = createTestClock(Date.now());
    const bridgeFailure = runWithDependencies([provideClock(clock.clock)], () =>
      new AppleNetworking(missingBridge.exec, {
        dns: "host-ipv6",
      }).prepareRun(),
    );
    await clock.waitForSleep();
    await clock.advanceBy(15_000);
    await expect(bridgeFailure).rejects.toThrow("host bridge");
    expect(count(missingBridge.events, ["delete"])).toBe(1);

    const missingInterface = createExecutor({
      guest: "1: lo inet 127.0.0.1/8 scope host lo\n",
    });
    await expect(
      new AppleNetworking(missingInterface.exec, {
        dns: "host-ipv6",
      }).prepareRun(),
    ).rejects.toThrow("guest interface");
    expect(count(missingInterface.events, ["delete"])).toBe(1);
  });

  test("keeps a matching builder and rejects an active mismatched builder", async () => {
    await withHostEnvironment(async () => {
      const matching = createExecutor({
        builderStates: ["matching", "matching"],
      });
      await new AppleNetworking(matching.exec, {
        dns: "host-ipv6",
      }).prepareBuild();
      expect(count(matching.events, ["builder", "start"])).toBe(0);
      expect(count(matching.events, ["delete"])).toBe(0);

      const mismatch = createExecutor({ builderStates: ["mismatched"] });
      await expect(
        new AppleNetworking(mismatch.exec, { dns: "host-ipv6" }).prepareBuild(),
      ).rejects.toThrow("active with different DNS settings");
      expect(count(mismatch.events, ["builder", "start"])).toBe(0);
      expect(count(mismatch.events, ["delete"])).toBe(1);
    });
  });

  test("starts a stopped builder, verifies DNS, and coalesces concurrent builds", async () => {
    await withHostEnvironment(async () => {
      const harness = createExecutor({
        builderStates: ["stopped", "stopped", "matching"],
      });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const exec: RuntimeExecutor = async (command, args, options) => {
        if (args?.[0] === "builder" && args[1] === "status") {
          entered.resolve();
          await release.promise;
        }
        return harness.exec(command, args, options);
      };
      const networking = new AppleNetworking(exec, {
        dns: "host-ipv6",
      });
      const first = networking.prepareBuild();
      await entered.promise;
      const second = networking.prepareBuild();
      release.resolve();
      await Promise.all([first, second]);
      expect(count(harness.events, ["builder", "start"])).toBe(1);
      expect(count(harness.events, ["builder", "status"])).toBe(3);
      expect(count(harness.events, ["run"])).toBe(1);
      expect(count(harness.events, ["delete"])).toBe(1);
    });
  });

  test("revalidates builder DNS after a completed preparation", async () => {
    await withHostEnvironment(async () => {
      const harness = createExecutor({
        builderStates: [
          "matching",
          "matching",
          "matching",
          "matching",
          "matching",
          "matching",
          "mismatched",
        ],
      });
      const networking = new AppleNetworking(harness.exec, {
        dns: "host-ipv6",
      });
      await networking.prepareBuild();
      await networking.prepareBuild();
      await expect(networking.prepareBuild()).rejects.toThrow(
        "active with different DNS settings",
      );
      expect(count(harness.events, ["builder", "start"])).toBe(0);
    });
  });

  test("rediscovers the bridge before preparing a later build", async () => {
    await withHostEnvironment(async () => {
      const harness = createExecutor({
        builderStates: ["matching"],
        bridge: [
          IFCONFIG,
          IFCONFIG,
          IFCONFIG.replace("fe80::1234", "fe80::5678"),
        ],
      });
      const networking = new AppleNetworking(harness.exec, {
        dns: "host-ipv6",
      });
      await networking.prepareBuild();
      await networking.prepareBuild();
      await expect(networking.prepareBuild()).rejects.toThrow(
        "active with different DNS settings",
      );
      expect(count(harness.events, ["builder", "start"])).toBe(0);
    });
  });

  test("leaves a dead owner's lock intact and reports manual recovery", async () => {
    await withHostEnvironment(async (root) => {
      const lockPath = path.join(root, "builder.lock");
      const owner = JSON.stringify({ pid: 2_147_483_647, token: "dead-owner" });
      fs.writeFileSync(lockPath, owner);
      fs.utimesSync(lockPath, new Date(0), new Date(0));
      const clock = createTestClock(Date.now());
      await expect(
        acquireAppleBuilderLock(lockPath, clock.clock),
      ).rejects.toThrow(
        "Remove the lock file only when no Sandbox builds are running",
      );
      expect(fs.readFileSync(lockPath, "utf8")).toBe(owner);
      expect(fs.readdirSync(root)).toEqual(["builder.lock"]);
    });
  });

  test("coordinates lock owners and preserves replacement locks", async () => {
    await withHostEnvironment(async () => {
      const root = fs.mkdtempSync(path.join(import.meta.dir, ".lock-test-"));
      using _cleanup = {
        [Symbol.dispose]: () =>
          fs.rmSync(root, { recursive: true, force: true }),
      };
      const lockPath = path.join(root, "builder.lock");
      const clock = createTestClock(Date.now());
      const timing = {
        retryMilliseconds: 10,
        waitMilliseconds: 30,
      };

      const first = await acquireAppleBuilderLock(
        lockPath,
        clock.clock,
        timing,
      );
      const waiting = acquireAppleBuilderLock(lockPath, clock.clock, timing);
      await clock.waitForSleep();
      await first[Symbol.asyncDispose]();
      await clock.advanceBy(10);
      const second = await waiting;
      expect(fs.existsSync(lockPath)).toBe(true);
      await second[Symbol.asyncDispose]();
      expect(fs.existsSync(lockPath)).toBe(false);

      const recovered = await acquireAppleBuilderLock(
        lockPath,
        clock.clock,
        timing,
      );
      const displaced = `${lockPath}.displaced`;
      fs.renameSync(lockPath, displaced);
      const replacement = await acquireAppleBuilderLock(
        lockPath,
        clock.clock,
        timing,
      );
      await recovered[Symbol.asyncDispose]();
      expect(fs.existsSync(lockPath)).toBe(true);
      await replacement[Symbol.asyncDispose]();
      fs.rmSync(displaced);
    });
  });

  test("does not reclaim an old lock owned by a live process", async () => {
    await withHostEnvironment(async () => {
      const root = fs.mkdtempSync(
        path.join(import.meta.dir, ".live-lock-test-"),
      );
      using _cleanup = {
        [Symbol.dispose]: () =>
          fs.rmSync(root, { recursive: true, force: true }),
      };
      const lockPath = path.join(root, "builder.lock");
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, token: "live-owner" }),
      );
      fs.utimesSync(lockPath, new Date(0), new Date(0));
      const clock = createTestClock(Date.now());
      const waiting = acquireAppleBuilderLock(lockPath, clock.clock, {
        retryMilliseconds: 10,
        waitMilliseconds: 10,
      });
      await clock.waitForSleep();
      await clock.advanceBy(10);
      await expect(waiting).rejects.toThrow("Timed out waiting");
      expect(fs.readFileSync(lockPath, "utf8")).toContain("live-owner");
    });
  });

  test("releases the builder lock after owner failure", async () => {
    await withHostEnvironment(async (dataHomeDirectory) => {
      const failed = createExecutor({ builderStates: ["mismatched"] });
      await expect(
        new AppleNetworking(failed.exec, { dns: "host-ipv6" }).prepareBuild(),
      ).rejects.toThrow("active with different DNS settings");
      expect(
        fs.existsSync(
          path.join(
            dataHomeDirectory,
            "sandbox",
            "locks",
            "apple-builder-dns.lock",
          ),
        ),
      ).toBe(false);
    });
  });

  test("creates and activates a missing selected network before discovery", async () => {
    const harness = createExecutor({ networks: ["[]", "[]", NETWORK] });
    const networking = new AppleNetworking(harness.exec, { dns: "host-ipv6" });

    {
      await using plan = await networking.prepareRun();
      expect(plan.dns).toBe(RESOLVER);
      expect(count(harness.events, ["network", "create", "default"])).toBe(1);
      expect(count(harness.events, ["run"])).toBe(1);
      expect(count(harness.events, ["delete"])).toBe(0);
    }
    expect(count(harness.events, ["delete"])).toBe(1);
    expect(harness.events.map(({ args }) => args.slice(0, 2))).toEqual([
      ["network", "list"],
      ["network", "create"],
      ["network", "list"],
      ["run", "-d"],
      ["network", "list"],
      ["-a"],
      ["exec", expect.any(String)],
      ["delete", "-f"],
    ]);
  });

  test("activates a selected network with no status without recreating it", async () => {
    const inactive = JSON.stringify([
      { id: "default", configuration: { name: "default" } },
    ]);
    const harness = createExecutor({ networks: [inactive, NETWORK] });
    const networking = new AppleNetworking(harness.exec, { dns: "default" });

    {
      await using plan = await networking.prepareRun();
      expect(plan.networkName).toBe("default");
      expect(count(harness.events, ["network", "create"])).toBe(0);
      expect(count(harness.events, ["run"])).toBe(1);
      expect(count(harness.events, ["delete"])).toBe(0);
    }
    expect(count(harness.events, ["delete"])).toBe(1);
  });
});
