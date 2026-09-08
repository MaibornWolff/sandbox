import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { setupContainerToolsAppTest } from "./__test__/index.js";

function writeContainerFile(
  root: string,
  relativePath: string,
  content: string,
): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function successfulProcess(
  app: Awaited<ReturnType<typeof setupContainerToolsAppTest>>,
  command: string,
  args: readonly string[],
  stdout: string,
): void {
  app.processes
    .expectStart({ match: { command: command, args: args } })
    .resolveResult({
      exitCode: 0,
      stdout,
      stderr: "",
    });
}

describe("container-tools application command routing", () => {
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    test(`prints Commander help for ${JSON.stringify(args)}`, async () => {
      await using app = await setupContainerToolsAppTest();
      const result = await app.cli.run(...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(
        "Usage: sandbox-container-tools [options] [command]",
      );
      expect(result.stdout).toContain("network");
      expect(result.stdout).toContain("settings");
      expect(result.stdout).toContain("x11");
    });
  }

  for (const args of [["version"], ["--version"], ["-V"]]) {
    test(`prints the immutable version for ${JSON.stringify(args)}`, async () => {
      await using app = await setupContainerToolsAppTest({ version: "1.2.3" });
      expect(await app.cli.run(...args)).toEqual({
        exitCode: 0,
        stdout: "1.2.3\n",
        stderr: "",
      });
    });
  }

  test("rejects malformed utility routes and unknown commands", async () => {
    await using app = await setupContainerToolsAppTest();
    const cases = [
      [["network", "init"], "unknown command 'init'"],
      [["network", "diagnostic"], "missing required argument 'source'"],
      [["network", "diagnostic", "invalid"], "Allowed choices are"],
      [["network", "state", "unexpected"], "too many arguments"],
      [["settings"], "Usage: sandbox-container-tools settings"],
      [["x11", "invalid"], "unknown command 'invalid'"],
      [["unknown"], "unknown command 'unknown'"],
    ] as const;

    for (const [args, message] of cases) {
      const result = await app.cli.run(...args);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
    }
  });
});

describe("container-tools network scenarios", () => {
  test("reads all diagnostic sources exactly", async () => {
    await using app = await setupContainerToolsAppTest();
    const sources = [
      ["firewall", "var/log/firewall-blocked.log", "blocked\n"],
      ["dns", "var/log/dns-proxy.log", "dns\n"],
      ["proxy-access", "var/log/proxy-access.log", "access\n"],
      ["proxy-cache", "var/log/squid-cache.log", "cache\n"],
    ] as const;
    for (const [, filePath, content] of sources) {
      writeContainerFile(app.roots.container, filePath, content);
    }
    for (const [source, , content] of sources) {
      expect(await app.cli.run("network", "diagnostic", source)).toEqual({
        exitCode: 0,
        stdout: content,
        stderr: "",
      });
    }
  });

  test("collects exact passive network state", async () => {
    await using app = await setupContainerToolsAppTest();
    writeContainerFile(
      app.roots.container,
      "etc/resolv.conf",
      "nameserver local\n",
    );
    writeContainerFile(
      app.roots.container,
      "etc/resolv.conf.upstream",
      "nameserver upstream\n",
    );
    for (const [command, args, output] of [
      ["date", ["-u"], "DATE\n"],
      ["uptime", [], "UPTIME\n"],
      ["ip", ["route"], "ROUTES\n"],
      ["ip", ["-brief", "address"], "ADDRESSES\n"],
      ["pgrep", ["-a", "dnsmasq"], "DNSMASQ\n"],
      ["pgrep", ["-a", "squid"], "SQUID\n"],
      ["pgrep", ["-a", "tcpdump"], "TCPDUMP\n"],
      ["ss", ["-lntup"], "SOCKETS\n"],
      ["iptables", ["-S", "OUTPUT"], "FIREWALL\n"],
    ] as const) {
      successfulProcess(app, command, args, output);
    }
    expect(await app.cli.run("network", "state")).toEqual({
      exitCode: 0,
      stdout:
        "\n--- TIME ---\nDATE\nUPTIME\n\n--- RESOLVER ---\n/etc/resolv.conf:\nnameserver local\n/etc/resolv.conf.upstream:\nnameserver upstream\n\n--- ROUTES ---\nROUTES\n\n--- ADDRESSES ---\nADDRESSES\n\n--- NETWORK PROCESSES ---\nDNSMASQ\nSQUID\nTCPDUMP\n\n--- LISTENING SOCKETS ---\nSOCKETS\n\n--- FIREWALL OUTPUT RULES ---\nFIREWALL\n",
      stderr: "",
    });
  });
});

describe("container-tools settings scenarios", () => {
  test("accepts empty settings", async () => {
    await using app = await setupContainerToolsAppTest();
    expect(await app.cli.run("settings", "sync")).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  test("applies a copied setting from the mounted host source", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: {
        SANDBOX_SETTINGS:
          '{"mountPaths":[],"copyPaths":[".codex/config.toml"]}',
      },
    });
    writeContainerFile(
      app.roots.container,
      "etc/sandbox/settings/.codex/config.toml",
      "host",
    );
    writeContainerFile(app.roots.home, ".codex/config.toml", "stale");

    expect(await app.cli.run("settings", "apply")).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(
      fs.readFileSync(
        path.join(app.roots.home, ".codex", "config.toml"),
        "utf8",
      ),
    ).toBe("host");
  });

  test("syncs valid JSON settings exactly", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: {
        SANDBOX_SETTINGS: '{"mountPaths":["config.json"],"copyPaths":[]}',
      },
    });
    writeContainerFile(app.roots.home, "config.json", "source");
    fs.mkdirSync(path.join(app.roots.container, "etc", "sandbox", "settings"), {
      recursive: true,
    });
    expect(await app.cli.run("settings", "sync")).toEqual({
      exitCode: 0,
      stdout: "→ Synced ~/config.json to host\n",
      stderr: "",
    });
    expect(
      fs.readFileSync(
        path.join(
          app.roots.container,
          "etc",
          "sandbox",
          "settings",
          "config.json",
        ),
        "utf8",
      ),
    ).toBe("source");
  });

  test("rejects invalid JSON settings", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { SANDBOX_SETTINGS: "{" },
    });
    expect(await app.cli.run("settings", "sync")).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Invalid SANDBOX_SETTINGS: expected valid JSON\n",
    });
  });

  test("reports sync failures through debug and command output", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: {
        SANDBOX_SETTINGS: '{"mountPaths":["blocked/new.json"],"copyPaths":[]}',
        SANDBOX_DEBUG: "1",
      },
    });
    writeContainerFile(app.roots.home, "blocked/new.json", "source");
    const settingsRoot = path.join(
      app.roots.container,
      "etc",
      "sandbox",
      "settings",
    );
    writeContainerFile(settingsRoot, "blocked", "not a directory");
    const source = path.join(app.roots.home, "blocked", "new.json");
    const destination = path.join(settingsRoot, "blocked", "new.json");
    const detail = `ENOTDIR: not a directory, copyfile '${source}' -> '${destination}'`;
    const result = await app.cli.run("settings", "sync");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      `[settings] failed to sync blocked/new.json: ${detail}\n`,
    );
    expect(result.stderr).toContain(
      `[container-tools] Error: Failed to sync settings:\n- blocked/new.json: ${detail}`,
    );
    expect(result.stderr).toEndWith(
      `Failed to sync settings:\n- blocked/new.json: ${detail}\n`,
    );
  });
});

describe("container-tools X11 scenarios", () => {
  test("reports exact success output", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { DISPLAY: ":1" },
    });
    successfulProcess(
      app,
      "xdpyinfo",
      [],
      "header\nscreen #0:\n  dimensions: 1920x1080 pixels\n  resolution: 96x96 dots per inch\ntrailer\n",
    );
    expect(await app.cli.run("x11", "test")).toEqual({
      exitCode: 0,
      stdout:
        "✅ X11 connection successful\n   Display: :1\nscreen #0:\n  dimensions: 1920x1080 pixels\n  resolution: 96x96 dots per inch\n",
      stderr: "",
    });
  });

  test("routes an X11 failure through stdout and its exit code", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { DISPLAY: ":2" },
    });
    app.processes.expectStart().rejectResult(new Error("connection refused"));
    expect(await app.cli.run("x11", "test")).toEqual({
      exitCode: 1,
      stdout: "❌ Cannot connect to X server at :2\n",
      stderr: "",
    });
  });
});

test("isolates complete settings workflows in parallel", async () => {
  await using first = await setupContainerToolsAppTest({
    variables: {
      SANDBOX_SETTINGS: '{"mountPaths":["first.json"],"copyPaths":[]}',
    },
  });
  await using second = await setupContainerToolsAppTest({
    variables: {
      SANDBOX_SETTINGS: '{"mountPaths":["second.json"],"copyPaths":[]}',
    },
  });
  for (const [app, file] of [
    [first, "first.json"],
    [second, "second.json"],
  ] as const) {
    writeContainerFile(app.roots.home, file, file);
    fs.mkdirSync(path.join(app.roots.container, "etc", "sandbox", "settings"), {
      recursive: true,
    });
  }

  const [firstResult, secondResult] = await Promise.all([
    first.cli.run("settings", "sync"),
    second.cli.run("settings", "sync"),
  ]);

  expect(firstResult).toEqual({
    exitCode: 0,
    stdout: "→ Synced ~/first.json to host\n",
    stderr: "",
  });
  expect(secondResult).toEqual({
    exitCode: 0,
    stdout: "→ Synced ~/second.json to host\n",
    stderr: "",
  });
  expect(fs.existsSync(path.join(first.roots.home, "second.json"))).toBe(false);
  expect(fs.existsSync(path.join(second.roots.home, "first.json"))).toBe(false);
});
