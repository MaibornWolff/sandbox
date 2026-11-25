import { expect, test } from "bun:test";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { provideClock } from "#platform/clock/index.js";
import { createRuntimeExecProcess } from "#platform/container-runtime/__test__/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import {
  CONTAINER_START_FAILED,
  openSessionControl,
} from "./session-control.js";

function controlFixture(options: {
  stdout: string;
  exitCode?: number;
  keepOpen?: boolean;
}) {
  let closed = false;
  const process = createRuntimeExecProcess({
    result: {
      stdout: options.stdout,
      stderr: "",
      exitCode: options.exitCode ?? 0,
    },
    keepOpen: options.keepOpen,
    onDispose: () => {
      closed = true;
    },
  });
  return {
    get closed() {
      return closed;
    },
    open: () =>
      openSessionControl({
        containers: { openExec: async () => process },
        containerId: "session",
        attempts: 2,
        timeoutMs: 100,
        command: [],
      }),
  };
}

for (const scenario of [
  {
    name: "rejects incomplete readiness",
    stdout: "sandbox-session-ready\n",
    exitCode: 0,
    expected: 1,
  },
  {
    name: "preserves readiness timeout",
    stdout: "",
    exitCode: 124,
    expected: 124,
  },
  {
    name: "preserves explicit container start hook failure",
    stdout: "sandbox-start-hooks-running\n",
    exitCode: CONTAINER_START_FAILED,
    expected: CONTAINER_START_FAILED,
  },
  {
    name: "preserves preparation failure",
    stdout: "sandbox-session-ready\n",
    exitCode: 23,
    expected: 23,
  },
  {
    name: "keeps a ready control open until disposal",
    stdout: "sandbox-session-ready\nsandbox-session-control-ready\n",
    exitCode: 0,
    expected: 0,
  },
]) {
  test(scenario.name, () =>
    runWithTestLogger(async () => {
      const fixture = controlFixture({
        ...scenario,
        keepOpen: scenario.expected === 0,
      });
      await using resources = new AsyncDisposableStack();
      const prepared = await fixture.open();
      resources.use(prepared.control);
      expect(prepared.result.exitCode).toBe(scenario.expected);
      expect(fixture.closed).toBe(false);
      await resources.disposeAsync();
      expect(fixture.closed).toBe(true);
    }),
  );
}

test("closes the control when readiness output exceeds its limit", () =>
  runWithTestLogger(async () => {
    const fixture = controlFixture({
      stdout: "x".repeat(16_385),
      keepOpen: true,
    });
    await expect(fixture.open()).rejects.toThrow(
      "Container session control output exceeded its limit",
    );
    expect(fixture.closed).toBe(true);
  }));

test("keeps a responsive startup hook phase open past the bootstrap budget", () =>
  runWithTestLogger(async () => {
    const clock = createTestClock();
    await using resources = new AsyncDisposableStack();
    resources.defer(() => clock.dispose());
    const phaseSeen = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<{ exitCode: number }>();
    const control = {
      stdout: (async function* () {
        yield Buffer.from("sandbox-start-hooks-running\n");
        phaseSeen.resolve();
        await ready.promise;
        yield Buffer.from(
          "sandbox-session-ready\nsandbox-session-control-ready\n",
        );
        await closed.promise;
      })(),
      stderr: (async function* () {
        yield Buffer.alloc(0);
      })(),
      completion: closed.promise,
      async [Symbol.asyncDispose]() {
        closed.resolve({ exitCode: 0 });
      },
    };
    await runWithDependencies([provideClock(clock.clock)], async () => {
      const preparation = openSessionControl({
        containers: { openExec: async () => control },
        containerId: "session",
        attempts: 2,
        timeoutMs: 100,
        command: [],
      });
      await phaseSeen.promise;
      await clock.advanceBy(3_000);
      ready.resolve();
      const prepared = await preparation;
      resources.use(prepared.control);
      expect(prepared.result.exitCode).toBe(0);
    });
  }));

test("times out when the startup hook heartbeat stops", () =>
  runWithTestLogger(async () => {
    const clock = createTestClock();
    await using resources = new AsyncDisposableStack();
    resources.defer(() => clock.dispose());
    const fixture = controlFixture({
      stdout: "sandbox-start-hooks-running\n",
      keepOpen: true,
    });
    await runWithDependencies([provideClock(clock.clock)], async () => {
      const preparation = fixture.open();
      await clock.waitForSleep();
      // A single pulse permits the hook phase but cannot hold the lease forever.
      await clock.advanceBy(1_100);
      await clock.advanceBy(5_000);
      const prepared = await preparation;
      resources.use(prepared.control);
      expect(prepared.result.exitCode).toBe(124);
    });
  }));

test("times out silent readiness and closes the control", () =>
  runWithTestLogger(async () => {
    const clock = createTestClock();
    await using resources = new AsyncDisposableStack();
    resources.defer(() => clock.dispose());
    const fixture = controlFixture({ stdout: "", keepOpen: true });
    await runWithDependencies([provideClock(clock.clock)], async () => {
      const preparation = fixture.open();
      await clock.waitForSleep();
      await clock.advanceBy(1_100);
      const prepared = await preparation;
      resources.use(prepared.control);
      expect(prepared.result.exitCode).toBe(124);
      await resources.disposeAsync();
      expect(fixture.closed).toBe(true);
    });
  }));
