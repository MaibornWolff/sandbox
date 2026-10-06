import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createTestSandboxEnvironment } from "#platform/environment/__test__/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { provideProcessManager } from "#platform/process/index.js";
import { createTestTerminal } from "#platform/terminal/__test__/index.js";
import { provideTerminal } from "#platform/terminal/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  getMountOwnershipTargets,
  inspectSessionActivity,
  parseIdeBridgePort,
  renderSshProxyConfiguration,
  repairMountOwnership,
  runSettingsApplyAsSandbox,
  runSettingsSyncAsSandbox,
  startIdeBridge,
  terminateContainerSessions,
} from "./container-lifecycle.js";

function writeSessionProcess(
  root: string,
  pid: number,
  state: "S" | "Z" = "S",
): void {
  const sessions = path.join(root, "tmp", "sandbox-sessions");
  const processDirectory = path.join(root, "proc", String(pid));
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(processDirectory, { recursive: true });
  fs.writeFileSync(path.join(sessions, String(pid)), "");
  fs.writeFileSync(
    path.join(processDirectory, "stat"),
    `${pid} (sandbox command) ${state} 1 ${pid} ${pid} 0 -1 0`,
  );
}

function sessionEnvironment(root: string) {
  const home = path.join(root, "home", "sandbox");
  fs.mkdirSync(home, { recursive: true });
  return createTestSandboxEnvironment({
    filesystemRoot: root,
    homeDirectory: home,
    variables: { HOME: home },
    platform: "linux",
  });
}

describe("container lifecycle mechanics", () => {
  test("selects mount roots and intermediate directories under owned roots", () => {
    const mounts = [
      "host /home/sandbox/.claude/skills bind rw 0 0",
      "host /home/sandbox/.claude/settings.json bind rw 0 0",
      "host /home/sandbox/.claude/skills bind rw 0 0",
      "host /etc/sandbox/settings bind rw 0 0",
      "host /etc/sandbox/settings/.phase11/seed.txt bind rw 0 0",
      "host /etc/sandbox/other bind rw 0 0",
      "host /workspace bind rw 0 0",
      "malformed",
    ].join("\n");

    expect(
      getMountOwnershipTargets(mounts, [
        "/home/sandbox",
        "/etc/sandbox/settings",
      ]),
    ).toEqual([
      "/home/sandbox/.claude/skills",
      "/home/sandbox/.claude",
      "/home/sandbox",
      "/home/sandbox/.claude/settings.json",
      "/etc/sandbox/settings",
      "/etc/sandbox/settings/.phase11/seed.txt",
      "/etc/sandbox/settings/.phase11",
    ]);
  });

  test("decodes escaped mount targets", () => {
    expect(
      getMountOwnershipTargets(
        "host /home/sandbox/my\\040settings bind rw 0 0",
        ["/home/sandbox"],
      ),
    ).toContain("/home/sandbox/my settings");
  });

  test("reads mount ownership state from the scoped container root", () => {
    const root = createTestDir("container-lifecycle-ownership");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const home = path.join(root, "home", "sandbox");
    fs.mkdirSync(path.join(root, "proc"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(root, "proc", "mounts"), "");
    const environment = createTestSandboxEnvironment({
      filesystemRoot: root,
      homeDirectory: home,
      variables: { HOME: home },
      platform: "linux",
    });
    expect(environment.run(repairMountOwnership)).toEqual([]);
  });

  test("repairs scoped settings mounts so new destination files can be created", () => {
    const root = createTestDir("container-lifecycle-settings-mount");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const home = path.join(root, "home", "sandbox");
    const settings = path.join(root, "etc", "sandbox", "settings");
    const phaseDirectory = path.join(settings, ".phase11");
    const seededFile = path.join(phaseDirectory, "seed.txt");
    fs.mkdirSync(path.join(root, "proc"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(phaseDirectory, { recursive: true });
    fs.writeFileSync(seededFile, "seed");
    fs.writeFileSync(
      path.join(root, "proc", "mounts"),
      [`host ${seededFile} bind rw 0 0`, "host /workspace bind rw 0 0"].join(
        "\n",
      ),
    );
    const environment = createTestSandboxEnvironment({
      filesystemRoot: root,
      homeDirectory: home,
      variables: { HOME: home },
      platform: "linux",
    });

    expect(environment.run(repairMountOwnership)).toEqual([
      seededFile,
      phaseDirectory,
      settings,
    ]);
    const generatedFile = path.join(phaseDirectory, "generated.txt");
    fs.writeFileSync(generatedFile, "generated");
    expect(fs.readFileSync(generatedFile, "utf8")).toBe("generated");
  });

  test("skips mounts that already have the expected ownership", () => {
    const root = createTestDir("container-lifecycle-owned-mount");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const home = path.join(root, "home", "sandbox");
    const target = path.join(home, ".settings", "config.json");
    fs.mkdirSync(path.join(root, "proc"), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "");
    fs.writeFileSync(
      path.join(root, "proc", "mounts"),
      `host ${target} bind ro 0 0`,
    );
    const environment = createTestSandboxEnvironment({
      filesystemRoot: root,
      homeDirectory: home,
      variables: { HOME: home },
      platform: "linux",
    });
    expect(environment.run(repairMountOwnership)).toEqual([
      target,
      path.dirname(target),
      home,
    ]);
  });

  test("tolerates a mount whose ownership cannot be repaired", () => {
    const root = createTestDir("container-lifecycle-ownership-failure");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const home = path.join(root, "home", "sandbox");
    const missingTarget = path.join(home, ".settings", "missing.json");
    fs.mkdirSync(path.join(root, "proc"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(root, "proc", "mounts"),
      `host ${missingTarget} bind rw 0 0`,
    );
    const environment = createTestSandboxEnvironment({
      filesystemRoot: root,
      homeDirectory: home,
      variables: { HOME: home },
      platform: "linux",
    });
    expect(environment.run(repairMountOwnership)).toEqual([
      missingTarget,
      path.dirname(missingTarget),
      home,
    ]);
  });

  test("removes an invalid session marker through scoped owners", () => {
    const root = createTestDir("container-lifecycle-sessions");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const home = path.join(root, "home", "sandbox");
    const sessions = path.join(root, "tmp", "sandbox-sessions");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, "invalid"), "");
    const environment = createTestSandboxEnvironment({
      filesystemRoot: root,
      homeDirectory: home,
      variables: { HOME: home },
      platform: "linux",
    });
    const processes = createProcessTestHarness();
    expect(
      environment.run(() =>
        runWithDependencies([provideProcessManager(processes.manager)], () =>
          inspectSessionActivity(),
        ),
      ),
    ).toEqual({ markerSeen: true, active: false });
    expect(fs.existsSync(path.join(sessions, "invalid"))).toBe(false);
  });

  test("removes a zombie session marker instead of treating it as active", () => {
    const root = createTestDir("container-lifecycle-zombie-session");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const home = path.join(root, "home", "sandbox");
    const sessions = path.join(root, "tmp", "sandbox-sessions");
    const processDirectory = path.join(root, "proc", "41");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(sessions, { recursive: true });
    fs.mkdirSync(processDirectory, { recursive: true });
    fs.writeFileSync(path.join(sessions, "41"), "");
    fs.writeFileSync(
      path.join(processDirectory, "stat"),
      "41 (sandbox command) Z 1 41 41 0 -1 0",
    );
    const environment = createTestSandboxEnvironment({
      filesystemRoot: root,
      homeDirectory: home,
      variables: { HOME: home },
      platform: "linux",
    });
    const processes = createProcessTestHarness();

    expect(
      environment.run(() =>
        runWithDependencies([provideProcessManager(processes.manager)], () =>
          inspectSessionActivity(),
        ),
      ),
    ).toEqual({ markerSeen: true, active: false });
    expect(fs.existsSync(path.join(sessions, "41"))).toBe(false);
  });

  test("removes a session marker when its PID disappears before capture", async () => {
    const root = createTestDir("container-lifecycle-disappeared-session");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    writeSessionProcess(root, 41);
    const processes = createProcessTestHarness();

    await sessionEnvironment(root).run(() =>
      runWithDependencies([provideProcessManager(processes.manager)], () =>
        terminateContainerSessions("SIGTERM"),
      ),
    );

    expect(
      fs.existsSync(path.join(root, "tmp", "sandbox-sessions", "41")),
    ).toBe(false);
    expect(processes.actions()).not.toContainEqual(
      expect.objectContaining({ type: "signal" }),
    );
  });

  test("refuses to signal a reused captured session PID", async () => {
    const clock = createTestClock();
    const processes = createProcessTestHarness(clock.clock);
    const session = processes.addExternalProcess({
      pid: 41,
      name: "session 41",
    });
    const captured = processes.manager.capture({ name: "session 41", pid: 41 });
    if (!captured) throw new Error("Expected captured session process.");
    session.changeIdentity();

    await expect(captured.stop({ signal: "SIGTERM" })).rejects.toMatchObject({
      name: "ProcessIdentityError",
      message: expect.stringContaining("operating-system identity changed"),
    });
    expect(session.signals).toEqual([]);
  });

  test("preserves session signal failures and starts every stop attempt", async () => {
    const root = createTestDir("container-lifecycle-session-signal-failure");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    for (const pid of [41, 42]) writeSessionProcess(root, pid);
    const clock = createTestClock();
    const processes = createProcessTestHarness(clock.clock);
    const first = new Error("first signal failed", {
      cause: new Error("first signal cause"),
    });
    const second = new Error("second signal failed");
    const firstSession = processes.addExternalProcess({ pid: 41 });
    const secondSession = processes.addExternalProcess({ pid: 42 });
    firstSession.failSignalsWith(first);
    secondSession.failSignalsWith(second);

    const failure = await sessionEnvironment(root)
      .run(() =>
        runWithDependencies([provideProcessManager(processes.manager)], () =>
          terminateContainerSessions("SIGINT"),
        ),
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(
      "Failed to terminate container sessions.",
    );
    expect(
      (failure as AggregateError).errors
        .map((error: Error) => error.message)
        .sort(),
    ).toEqual([
      "Failed to terminate session 41.",
      "Failed to terminate session 42.",
    ]);
    expect(firstSession.signals).toEqual(["SIGINT"]);
    expect(secondSession.signals).toEqual(["SIGINT"]);
    const firstFailure = (failure as AggregateError).errors.find(
      (error: Error) => error.message === "Failed to terminate session 41.",
    );
    expect(firstFailure?.cause.cause).toBe(first);
    firstSession.disappear();
    secondSession.disappear();
    await clock.advanceBy(50);
  });

  test("escalates a session to SIGKILL through the managed lifecycle", async () => {
    const root = createTestDir("container-lifecycle-session-escalation");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    writeSessionProcess(root, 41);
    const clock = createTestClock();
    const processes = createProcessTestHarness(clock.clock);
    const session = processes.addExternalProcess({ pid: 41 });
    session.exitOnSignal("SIGKILL");

    const termination = sessionEnvironment(root).run(() =>
      runWithDependencies([provideProcessManager(processes.manager)], () =>
        terminateContainerSessions("SIGTERM"),
      ),
    );
    await clock.waitForSleep();
    await clock.advanceBy(5_000);
    await expect(termination).resolves.toBeUndefined();
    expect(session.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("reports a session survivor with managed shutdown details", async () => {
    const root = createTestDir("container-lifecycle-session-survivor");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    writeSessionProcess(root, 41);
    const clock = createTestClock();
    const processes = createProcessTestHarness(clock.clock);
    processes.addExternalProcess({ pid: 41 });

    const termination = sessionEnvironment(root).run(() =>
      runWithDependencies([provideProcessManager(processes.manager)], () =>
        terminateContainerSessions("SIGTERM"),
      ),
    );
    await clock.waitForSleep();
    await clock.advanceBy(5_000);
    await clock.waitForSleep();
    await clock.advanceBy(5_000);
    await expect(termination).rejects.toMatchObject({
      message: "Failed to terminate session 41.",
      cause: {
        name: "ProcessShutdownError",
        targets: [{ name: "session 41", pid: 41, phase: "forced" }],
      },
    });
  });

  test("validates IDE bridge ports", () => {
    expect(parseIdeBridgePort(undefined)).toBeUndefined();
    expect(parseIdeBridgePort("")).toBeUndefined();
    expect(parseIdeBridgePort("10000")).toBe(10_000);
    expect(parseIdeBridgePort("65535")).toBe(65_535);
    for (const invalid of ["text", "9999", "65536"]) {
      expect(() => parseIdeBridgePort(invalid)).toThrow(
        `Invalid IDE bridge port: ${invalid}`,
      );
    }
  });

  test("starts an owner-required managed socat bridge", async () => {
    const processes = createProcessTestHarness();
    const child = processes.expectStart({ match: { name: "ide-bridge" } });
    const lifecycle = processes.run(() =>
      startIdeBridge(12_345, "host.container.internal"),
    );

    child.exit({ exitCode: 7 });
    await expect(lifecycle.failure).resolves.toMatchObject({
      message: "ide-bridge exited with code 7",
    });
    expect(
      processes.actions().find((action) => action.type === "start"),
    ).toMatchObject({
      type: "start",
      process: child,
      request: {
        name: "ide-bridge",
        command: "/usr/bin/socat",
        args: [
          "TCP-LISTEN:12345,bind=127.0.0.1,fork,reuseaddr",
          "TCP:host.container.internal:12345",
        ],
        stdio: "ignore",
      },
    });
  });

  test("runs settings apply as sandbox", async () => {
    const processes = createProcessTestHarness();
    const terminal = createTestTerminal();
    processes
      .expectStart({
        match: {
          command: "/usr/sbin/gosu",
          args: [
            "sandbox",
            "/usr/local/bin/sandbox-container-tools",
            "settings",
            "apply",
          ],
        },
      })
      .resolveResult({ exitCode: 0, stdout: "", stderr: "" });

    await runWithDependencies(
      [provideProcessManager(processes.manager), provideTerminal(terminal.io)],
      () => runSettingsApplyAsSandbox(),
    );
    expect(processes.requests[0]).toEqual({
      command: "/usr/sbin/gosu",
      args: [
        "sandbox",
        "/usr/local/bin/sandbox-container-tools",
        "settings",
        "apply",
      ],
    });
  });

  test("runs settings sync as sandbox and forwards its output", async () => {
    const processes = createProcessTestHarness();
    const terminal = createTestTerminal();
    processes
      .expectStart({
        match: {
          command: "/usr/sbin/gosu",
          args: [
            "sandbox",
            "/usr/local/bin/sandbox-container-tools",
            "settings",
            "sync",
          ],
        },
      })
      .resolveResult({
        exitCode: 0,
        stdout: "→ Synced ~/.claude/new.json to host\n",
        stderr: "",
      });

    await runWithDependencies(
      [provideProcessManager(processes.manager), provideTerminal(terminal.io)],
      () => runSettingsSyncAsSandbox(),
    );

    // Debian's gosu apt package installs to /usr/sbin/gosu, not /usr/bin/gosu.
    expect(processes.requests).toEqual([
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
    expect(terminal.stdout()).toBe("→ Synced ~/.claude/new.json to host\n");
  });

  test("renders private SSH bypasses and Squid proxy command", () => {
    const config = renderSshProxyConfiguration();
    expect(config).toContain("Host 127.* localhost 10.*");
    expect(config).toContain("172.2?.* 172.3?.* 192.168.*");
    expect(config).toContain(
      "ProxyCommand socat - PROXY:127.0.0.1:%h:%p,proxyport=8888",
    );
  });
});
