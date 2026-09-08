import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import {
  type ContainerToolsAppTest,
  type ContainerToolsChild,
  setupContainerToolsAppTest,
} from "./container-tools-app-test.js";

const proxyEndpoint = { host: "127.0.0.1", port: 8888 } as const;
const dnsEndpoint = { host: "127.0.0.1", port: 53 } as const;

async function startReadyEntrypoint(
  app: ContainerToolsAppTest,
  child: ContainerToolsChild,
): Promise<{
  readonly execution: ReturnType<ContainerToolsAppTest["entrypoint"]["start"]>;
}> {
  const execution = app.entrypoint.start("ignored-command");
  await app.children.waitForSpawn();
  await app.idle.waitForTick();
  expect(child.name).toBe("ide-bridge");
  expect(app.entrypoint.isReady()).toBe(true);
  return { execution };
}

describe("container-tools PID 1 harness contract", () => {
  test("rejects a concurrent CLI run that would share the application terminal", async () => {
    const app = await setupContainerToolsAppTest({
      variables: { DISPLAY: ":9" },
    });
    app.processes.expectStart();
    const execution = app.cli.run("x11", "test");
    void execution.catch(() => undefined);
    await Promise.resolve();

    expect(() => app.cli.run("version")).toThrow(
      "Only one container-tools execution may use an application terminal at a time.",
    );

    await app[Symbol.asyncDispose]();
  });

  test("times out when readiness is impossible without an entrypoint execution", async () => {
    await using app = await setupContainerToolsAppTest();

    await expect(app.entrypoint.waitForReady()).rejects.toThrow(
      "Timed out waiting for container readiness.",
    );
  });

  test("composes generic process, TCP, clock, filesystem, and owner-local lifecycle state", async () => {
    await using app = await setupContainerToolsAppTest({
      variables: { DISPLAY: ":7" },
    });
    const required = app.children.givenRequired("required-daemon");
    const optional = app.children.givenOptional("optional-daemon", {
      ready: true,
      messages: ["listening"],
    });
    const requiredChild = app.processes.manager.start({
      command: "required",
      name: "required-daemon",
      lifetime: "application",
      interaction: { mode: "non-interactive" },
    });
    const optionalChild = app.processes.manager.start({
      command: "optional",
      name: "optional-daemon",
      lifetime: "application",
      interaction: { mode: "non-interactive" },
    });
    required.markReady();
    const stopping = app.processes.run(() => requiredChild.stop());
    required.exit({ signal: "SIGTERM" });
    await stopping;
    optional.exit({ exitCode: 3, stderr: "optional stopped" });
    app.sockets.listen(proxyEndpoint);
    app.sockets.close(dnsEndpoint);
    app.sessions.givenActive(41);
    app.sessions.givenMarker("stale");
    app.files.write("/var/run/network.state", "ready");

    const sleeper = app.clock.clock.sleep(1_000);
    await app.idle.waitForTick();
    await app.idle.advanceToNextTick();
    await sleeper;

    expect(required.pid).toBe(1_000);
    expect(await requiredChild.result).toMatchObject({ signal: "SIGTERM" });
    expect(await optionalChild.result).toMatchObject({ exitCode: 3 });
    expect(optional.isReady()).toBe(true);
    expect(optional.messages).toEqual(["listening"]);
    expect(app.children.events().map((action) => action.type)).toEqual([
      "start",
      "start",
      "signal",
    ]);
    expect(app.sockets.open()).toEqual([proxyEndpoint]);
    expect(app.sessions.markerExists(41)).toBe(true);
    expect(app.sessions.markerExists("stale")).toBe(true);
    expect(app.files.read("/var/run/network.state")).toBe("ready");
    expect(app.idle.pendingTicks()).toBe(0);
  });

  test("isolates concurrent PID 1 signals, children, timers, sockets, files, output, and environment", async () => {
    const first = await setupContainerToolsAppTest({
      variables: {
        CLAUDE_CODE_SSE_PORT: "11001",
        SANDBOX_DEBUG: "1",
        SANDBOX_IDLE_TIMEOUT_SECONDS: "60",
        INSTANCE: "first",
      },
    });
    const second = await setupContainerToolsAppTest({
      variables: {
        CLAUDE_CODE_SSE_PORT: "22002",
        SANDBOX_DEBUG: "1",
        SANDBOX_IDLE_TIMEOUT_SECONDS: "60",
        INSTANCE: "second",
      },
    });
    const firstChild = first.children.givenRequired("ide-bridge");
    const secondChild = second.children.givenRequired("ide-bridge");
    first.sockets.listen(proxyEndpoint);
    second.sockets.listen(dnsEndpoint);
    first.networkState.givenFile("/var/run/network.state", "first");
    second.networkState.givenFile("/var/run/network.state", "second");
    first.settings.givenFinalSync({
      exitCode: 0,
      stdout: "first sync\n",
      stderr: "",
    });
    second.settings.givenFinalSync({
      exitCode: 0,
      stdout: "second sync\n",
      stderr: "",
    });

    const [firstStarted, secondStarted] = await Promise.all([
      startReadyEntrypoint(first, firstChild),
      startReadyEntrypoint(second, secondChild),
    ]);
    first.sessions.givenActive(101);
    second.sessions.givenActive(202);
    expect(first.signals.subscriptions()).toBe(1);
    expect(second.signals.subscriptions()).toBe(1);
    expect(first.idle.pendingTicks()).toBe(1);
    expect(second.idle.pendingTicks()).toBe(1);

    first.signals.send("SIGINT");
    await expect(firstChild.waitForSignal()).resolves.toBe("SIGINT");
    firstChild.exit({ signal: "SIGINT" });
    expect(await firstStarted.execution).toMatchObject({
      exitCode: 130,
      stdout: "first sync\n",
    });
    expect(firstChild.signals).toEqual(["SIGINT"]);
    expect(secondChild.signals).toEqual([]);
    expect(second.signals.subscriptions()).toBe(1);
    expect(second.idle.pendingTicks()).toBe(1);

    second.cancellation.cancelNetworkStartup();
    await expect(secondChild.waitForSignal()).resolves.toBe("SIGTERM");
    secondChild.exit({ signal: "SIGTERM" });
    expect(await secondStarted.execution).toMatchObject({
      exitCode: 143,
      stdout: "second sync\n",
    });

    expect(first.environment.variables.INSTANCE).toBe("first");
    expect(second.environment.variables.INSTANCE).toBe("second");
    expect(first.networkState.readFile("/var/run/network.state")).toBe("first");
    expect(second.networkState.readFile("/var/run/network.state")).toBe(
      "second",
    );
    expect(first.sockets.open()).toEqual([proxyEndpoint]);
    expect(second.sockets.open()).toEqual([dnsEndpoint]);
    expect(first.output.stderr()).toContain("[container-tools] ready");
    expect(second.output.stderr()).toContain("[container-tools] ready");
    expect(first.settings.finalSyncRequests()).toBe(1);
    expect(second.settings.finalSyncRequests()).toBe(1);
    expect(first.idle.pendingTicks()).toBe(0);
    expect(second.idle.pendingTicks()).toBe(0);

    const firstRoot = first.roots.temporary;
    const secondRoot = second.roots.temporary;
    await Promise.all([
      first[Symbol.asyncDispose](),
      second[Symbol.asyncDispose](),
    ]);
    for (const app of [first, second]) {
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
      expect(app.children.pending()).toBe(0);
      expect(app.signals.subscriptions()).toBe(0);
      expect(app.idle.pendingTicks()).toBe(0);
      expect(app.sockets.open()).toEqual([]);
    }
    expect(fs.existsSync(firstRoot)).toBe(false);
    expect(fs.existsSync(secondRoot)).toBe(false);
  });

  test("async disposal cancels pending executions and removes all owned resources", async () => {
    const app = await setupContainerToolsAppTest({
      variables: { DISPLAY: ":9" },
    });
    const root = app.roots.temporary;
    app.processes.expectStart();
    app.sockets.listen(proxyEndpoint);
    const sleeping = app.clock.clock.sleep(10_000);
    void sleeping.catch(() => undefined);
    void app.processes.manager.termination;
    const execution = app.cli.run("x11", "test");
    await Promise.resolve();

    await app[Symbol.asyncDispose]();

    await expect(execution).resolves.toMatchObject({ exitCode: 1 });
    await expect(sleeping).rejects.toThrow("disposed");
    expect(app.children.pending()).toBe(0);
    expect(app.signals.subscriptions()).toBe(0);
    expect(app.idle.pendingTicks()).toBe(0);
    expect(app.sockets.open()).toEqual([]);
    expect(fs.existsSync(root)).toBe(false);
  });
});
