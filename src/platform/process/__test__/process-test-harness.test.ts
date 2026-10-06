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

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

describe("process test harness", () => {
  test("rejects impossible signal and exit-code combinations", async () => {
    const harness = createProcessTestHarness();
    const process = harness.expectStart({ match: { command: "tool" } });
    process.resolveResult({
      exitCode: 1,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
    });

    const managed = start(harness);

    await expect(managed.result).rejects.toThrow(
      "Signal SIGTERM requires exit code 143, received 1.",
    );
    await expect(managed.exited).resolves.toEqual({});
  });

  test("claims partial request expectations out of order", async () => {
    const second = createProcessTestHarness();
    const expectedSecond = second.expectStart({ match: { name: "second" } });
    const expectedFirst = second.expectStart({ match: { name: "first" } });

    const first = start(second, { name: "first" });
    const last = start(second, { name: "second" });
    expectedFirst.emitStdout("first output");
    expectedFirst.exit();
    expectedSecond.exit();

    await expect(first.result).resolves.toMatchObject({
      stdout: "first output",
    });
    await expect(last.result).resolves.toMatchObject({ exitCode: 0 });
    expect(second.requests.map((request) => request.name)).toEqual([
      "first",
      "second",
    ]);
  });

  test("rejects a process that does not match an expectation", async () => {
    const harness = createProcessTestHarness();
    harness.expectStart({ match: { name: "expected" } });

    const managed = start(harness, { name: "different" });

    await expect(managed.result).rejects.toThrow(
      'Unexpected process request: command="tool", args=[], mode=spawn.',
    );
  });

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

  test("preserves non-error cancellation as an AbortError", async () => {
    const clock = createTestClock();
    const harness = createProcessTestHarness(clock.clock);
    const controller = new AbortController();
    harness.expectStart({ rejectOnAbort: true });
    const managed = start(harness, { signal: controller.signal });

    controller.abort("cancelled");

    await expect(managed.result).rejects.toMatchObject({ name: "AbortError" });
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

  test("models streaming input, output, and backpressure", async () => {
    const harness = createProcessTestHarness();
    const process = harness.expectStart({ match: { stdio: "stream" } });
    const managed = startStreaming(harness);
    const stdout = collect(managed.stdout);
    const stderr = collect(managed.stderr);
    const releaseInput = process.pauseInput();

    let writeSettled = false;
    const writing = managed.stdin.write(Buffer.from("request")).then(() => {
      writeSettled = true;
    });
    await expect(process.waitForInput()).resolves.toEqual(
      Buffer.from("request"),
    );
    await Promise.resolve();
    expect(writeSettled).toBe(false);

    releaseInput();
    await writing;
    await managed.stdin.end();
    await expect(process.waitForInputEnd()).resolves.toBeUndefined();
    process.emitStdout("response");
    process.emitStderr("warning");
    process.exit({ exitCode: 19 });

    await expect(stdout).resolves.toBe("response");
    await expect(stderr).resolves.toBe("warning");
    await expect(managed.result).resolves.toEqual({ exitCode: 19 });
  });

  test("keeps input failures for pending and subsequent writes", async () => {
    const harness = createProcessTestHarness();
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => harness.dispose());
    const process = harness.expectStart({ match: { stdio: "stream" } });
    const managed = startStreaming(harness);
    process.pauseInput();
    const writing = managed.stdin.write(Buffer.from("pending"));
    await process.waitForInput();
    const failure = new Error("input closed");
    process.failInput(failure);
    await expect(writing).rejects.toBe(failure);
    process.failInput(new Error("later failure"));
    await expect(managed.stdin.write(Buffer.from("next"))).rejects.toBe(
      failure,
    );
    process.exit();
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

  test("disposal rejects expected and started process waiters", async () => {
    const harness = createProcessTestHarness();
    const expected = harness.expectStart({ match: { name: "never" } });
    const started = harness.expectStart({ match: { command: "tool" } });
    const managed = start(harness);
    const signal = started.waitForSignal();

    await harness.dispose();

    await expect(expected.waitForStart()).rejects.toThrow(
      "process test harness was disposed",
    );
    await expect(managed.result).rejects.toThrow(
      "process test harness was disposed",
    );
    await expect(signal).rejects.toThrow("process test harness was disposed");
    expect(harness.pendingProcesses()).toBe(0);
  });
});
