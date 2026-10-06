import { describe, expect, test } from "bun:test";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { provideProcessManager } from "#platform/process/index.js";
import { stripAnsi } from "#test/utils.js";
import { startContainerLogStream } from "./log-stream.js";

function createLogTestClock() {
  let now = 0;
  return {
    clock: {
      now: () => now,
      sleep: async () => undefined,
    },
    advanceBy(milliseconds: number) {
      now += milliseconds;
    },
  };
}

describe("container log stream", () => {
  test("routes complete lines through the host logger with global timing", async () => {
    const clock = createLogTestClock();
    const processes = createProcessTestHarness(clock.clock);
    const child = processes.expectStart({ rejectOnAbort: true });
    const output: string[] = [];
    const logger = createLogger(
      clock.clock,
      (message) => output.push(message),
      {
        verbose: true,
      },
    );

    const stream = runWithDependencies(
      [provideLogger(logger), provideProcessManager(processes.manager)],
      () =>
        startContainerLogStream(
          { binaryName: "podman", runtime: "podman" },
          "sandbox-project",
        ),
    );
    clock.advanceBy(25);
    child.emitStdout("[container-tools] entrypoint starting\n");
    child.emitStdout("[container-tools] mount ownership repaired\n");
    const request = await child.waitForStart();
    const unicodeLine = Buffer.from("[container-tools] ready 🐳\n");
    request.onStdout?.(unicodeLine.subarray(0, unicodeLine.length - 2));
    request.onStdout?.(unicodeLine.subarray(unicodeLine.length - 2));
    request.onStderr?.(Buffer.from("x".repeat(16_384)));
    request.onStderr?.(Buffer.from("final partial line"));
    const firstStop = stream.stop();
    const secondStop = stream.stop();
    expect(child.signals).toEqual(["SIGTERM"]);
    child.exit({ signal: "SIGTERM" });
    await firstStop;

    expect(secondStop).toBe(firstStop);
    expect(output.map(stripAnsi)).toEqual([
      "[+25ms] [container-tools] entrypoint starting",
      "[+25ms] [container-tools] mount ownership repaired",
      "[+25ms] [container-tools] ready 🐳",
      `[+25ms] ${"x".repeat(16_384)}`,
      "[+25ms] final partial line",
    ]);
    expect(processes.requests).toHaveLength(1);
    expect(processes.requests[0]).toMatchObject({
      command: "podman",
      args: ["logs", "--follow", "--tail", "200", "sandbox-project"],
      stdio: "ignore",
      stdin: "ignore",
      onStdout: expect.any(Function),
      onStderr: expect.any(Function),
      name: "container log stream",
    });
    expect(processes.requests[0]?.signal).toBeUndefined();
  });

  test("reports captured startup logs when readiness fails", async () => {
    const clock = createLogTestClock();
    const processes = createProcessTestHarness(clock.clock);
    const child = processes.expectStart({ rejectOnAbort: true });
    const output: string[] = [];
    const logger = createLogger(
      clock.clock,
      (message) => output.push(message),
      {
        verbose: false,
      },
    );
    const stream = runWithDependencies(
      [provideLogger(logger), provideProcessManager(processes.manager)],
      () =>
        startContainerLogStream(
          { binaryName: "docker", runtime: "docker" },
          "failed-container",
        ),
    );

    child.emitStdout("[container-tools] entrypoint starting\n");
    const request = await child.waitForStart();
    request.onStderr?.(Buffer.from("squid failed to start\n"));
    const stopping = stream.stop();
    child.exit({ signal: "SIGTERM" });
    await stopping;
    stream.reportFailure();

    expect(output.map(stripAnsi)).toContain(
      "✗ Container startup logs for failed-container:\n[container-tools] entrypoint starting\nsquid failed to start",
    );
  });

  test("bounds shutdown and escalates an unresponsive follower", async () => {
    const clock = createLogTestClock();
    const processes = createProcessTestHarness(clock.clock);
    const child = processes.expectStart();
    const output: string[] = [];
    const logger = createLogger(
      clock.clock,
      (message) => output.push(message),
      {
        verbose: true,
      },
    );
    const stream = runWithDependencies(
      [provideLogger(logger), provideProcessManager(processes.manager)],
      () =>
        startContainerLogStream(
          { binaryName: "docker", runtime: "docker" },
          "sandbox-project",
        ),
    );

    const stopping = stream.stop();
    await expect(child.waitForSignal()).resolves.toBe("SIGTERM");
    while (child.signals.length < 2) await Promise.resolve();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await stopping;
    const outputAfterStop = output.length;
    const request = await child.waitForStart();
    request.onStdout?.(Buffer.from("late output\n"));

    expect(output).toHaveLength(outputAfterStop);
    expect(output.map(stripAnsi)).toContain(
      "⚠ Container log stream for sandbox-project did not exit after SIGKILL",
    );
    child.rejectResult(new Error("unresponsive follower released"));
    await Promise.resolve();
    expect(processes.pendingProcesses()).toBe(0);
  });
});
