import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createSandboxEnvironment,
  provideSandboxEnvironment,
} from "#platform/environment/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { provideProcessManager } from "#platform/process/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { collectPassiveNetworkState, readContainerLog } from "./diagnostics.js";

function environment(root: string) {
  return createSandboxEnvironment({
    filesystemRoot: root,
    homeDirectory: path.join(root, "home", "sandbox"),
    variables: {},
    platform: "linux",
  });
}

describe("container diagnostics", () => {
  test("reads source-specific logs from the scoped container root", () => {
    const root = createTestDir("container-diagnostics");
    try {
      fs.mkdirSync(path.join(root, "var", "log"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "var", "log", "dns-proxy.log"),
        "dns output\n",
      );
      const output = runWithDependencies(
        [provideSandboxEnvironment(environment(root))],
        () => ({
          firewall: readContainerLog("firewall"),
          proxy: readContainerLog("proxy-access"),
          dns: readContainerLog("dns"),
          cache: readContainerLog("proxy-cache"),
        }),
      );
      expect(output).toEqual({
        firewall: "No blocked requests recorded.\n",
        proxy: "Proxy log file not found: /var/log/proxy-access.log\n",
        dns: "dns output\n",
        cache: "",
      });
    } finally {
      cleanupTestDir(root);
    }
  });

  test("collects passive state through scoped process and filesystem owners", async () => {
    const root = createTestDir("container-network-state");
    const processes = createProcessTestHarness();
    try {
      fs.mkdirSync(path.join(root, "etc"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "etc", "resolv.conf"),
        "nameserver 127.0.0.1\n",
      );
      fs.writeFileSync(
        path.join(root, "etc", "resolv.conf.upstream"),
        "nameserver 1.1.1.1\n",
      );
      for (const [command, args] of [
        ["date", ["-u"]],
        ["uptime", []],
        ["ip", ["route"]],
        ["ip", ["-brief", "address"]],
        ["pgrep", ["-a", "dnsmasq"]],
        ["pgrep", ["-a", "tcpdump"]],
        ["iptables", ["-S", "OUTPUT"]],
      ] as const) {
        processes
          .expectStart({ match: { command: command, args: args } })
          .resolveResult({
            exitCode: 0,
            stdout: `${command} ${args.join(" ")}\n`,
            stderr: "",
          });
      }
      processes
        .expectStart({ match: { command: "pgrep", args: ["-a", "squid"] } })
        .resolveResult({
          exitCode: 1,
          stdout: "",
          stderr: "not running",
        });
      processes.expectStart().rejectResult(new Error("ss unavailable"));

      const output = await runWithDependencies(
        [
          provideSandboxEnvironment(environment(root)),
          provideProcessManager(processes.manager),
        ],
        collectPassiveNetworkState,
      );

      for (const title of [
        "TIME",
        "RESOLVER",
        "ROUTES",
        "ADDRESSES",
        "NETWORK PROCESSES",
        "LISTENING SOCKETS",
        "FIREWALL OUTPUT RULES",
      ]) {
        expect(output).toContain(`--- ${title} ---`);
      }
      expect(output).toContain(
        "squid: not running or process status unavailable",
      );
      expect(output).toContain("ss unavailable");
      expect(output).toContain("nameserver 127.0.0.1");
      expect(output).toContain("nameserver 1.1.1.1");
    } finally {
      cleanupTestDir(root);
    }
  });
});
