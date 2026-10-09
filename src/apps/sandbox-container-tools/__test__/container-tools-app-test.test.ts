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
});
