import { describe, expect, test } from "bun:test";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { createProcessTestHarness } from "./process-test-harness.js";

function start(
  harness: ReturnType<typeof createProcessTestHarness>,
  options: { readonly name?: string; readonly signal?: AbortSignal } = {},
) {
  return harness.manager.start({
    command: "tool",
    ...(options.name ? { name: options.name } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    lifetime: "application",
    interaction: { mode: "non-interactive" },
    stdio: "ignore",
  });
}

function startStreaming(harness: ReturnType<typeof createProcessTestHarness>) {
  return harness.manager.start({
    command: "tool",
    lifetime: "application",
    interaction: { mode: "non-interactive" },
    stdio: "stream",
  });
}

describe("process test harness", () => {
  test("settles a result without implying that the process exited", async () => {
    const harness = createProcessTestHarness();
    const process = harness.expectStart();
    process.resolveResult(
      { exitCode: 0, stdout: "complete", stderr: "" },
      true,
    );

    const managed = start(harness);

    await expect(managed.result).resolves.toMatchObject({ stdout: "complete" });
    expect(harness.pendingProcesses()).toBe(1);
    process.disappear();
    await expect(managed.exited).resolves.toEqual({ exitCode: 0 });
    expect(harness.pendingProcesses()).toBe(0);
  });

  test("removes signal subscriptions through manager disposal", async () => {
    const harness = createProcessTestHarness();
    void harness.manager.termination;
    expect(harness.listenerCount()).toBe(1);

    await harness.manager.dispose();

    expect(harness.listenerCount()).toBe(0);
  });

  test("uses one controller for captured process identity and signals", async () => {
    const clock = createTestClock();
    const harness = createProcessTestHarness(clock.clock);
    const process = harness.addExternalProcess({ pid: 41, name: "session" });
    const managed = harness.manager.capture({ name: "session", pid: 41 });
    if (!managed) throw new Error("Expected captured process.");

    const stopping = managed.stop();
    await expect(process.waitForSignal()).resolves.toBe("SIGTERM");
    process.disappear();
    await clock.advanceBy(50);

    await expect(stopping).resolves.toEqual({});
    expect(process.signals).toEqual(["SIGTERM"]);
  });

  test("settles streaming operations on signal and disposal", async () => {
    const harness = createProcessTestHarness();
    const process = harness.expectStart({ match: { stdio: "stream" } });
    process.exitOnSignal("SIGTERM");
    const managed = startStreaming(harness);
    const output = managed.stdout[Symbol.asyncIterator]().next();

    await managed.dispose();

    await expect(output).resolves.toEqual({ done: true, value: undefined });
    await expect(managed.result).resolves.toEqual({
      exitCode: 143,
      signal: "SIGTERM",
    });
    await expect(managed.exited).resolves.toEqual({ signal: "SIGTERM" });
  });
});
