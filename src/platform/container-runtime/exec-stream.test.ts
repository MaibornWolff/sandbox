import { expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { openContainerExec } from "./exec-stream.js";

test("managed container exec streams bytes and closes control input before awaiting remote cleanup", () =>
  runWithTestLogger(async () => {
    const processes = createProcessTestHarness();
    const remote = processes.expectStart({ match: { stdio: "stream" } });
    await processes.run(async () => {
      await using execution = openContainerExec("runtime", [
        "exec",
        "-i",
        "session",
        "proxy",
      ]);
      await remote.waitForStart();
      const bytes = Uint8Array.of(0, 255, 3);
      remote.emitStdout(bytes);
      expect(
        await execution.stdout[Symbol.asyncIterator]().next(),
      ).toMatchObject({ done: false, value: bytes });
      remote.emitStderr(bytes);
      let disposed = false;
      const disposal = execution[Symbol.asyncDispose]().then(() => {
        disposed = true;
      });
      await remote.waitForInputEnd();
      expect(disposed).toBe(false);
      expect(remote.signals).toEqual([]);
      remote.exit({ exitCode: 0 });
      await disposal;
      expect(disposed).toBe(true);
      expect(await execution.completion).toEqual({ exitCode: 0 });
      expect(
        await execution.stderr[Symbol.asyncIterator]().next(),
      ).toMatchObject({ done: false, value: bytes });
    });
  }));

test("bounds disposal and releases readers when the runtime client stalls during stdin close", async () => {
  const clock = createTestClock();
  const processes = createProcessTestHarness(clock.clock);
  const remote = processes.expectStart({
    match: { stdio: "stream" },
    rejectOnAbort: true,
  });
  remote.pauseInput();
  try {
    await runWithTestLogger(
      () =>
        processes.run(async () => {
          const execution = openContainerExec("runtime", ["exec"]);
          const output = execution.stdout[Symbol.asyncIterator]().next();
          const disposal = Promise.resolve(execution[Symbol.asyncDispose]());
          void output.catch(() => undefined);
          void disposal.catch(() => undefined);
          await clock.advanceBy(4_999);
          expect(remote.signals).toEqual([]);
          await clock.advanceBy(1);
          expect(await remote.waitForSignal()).toBe("SIGTERM");
          await clock.advanceBy(5_000);
          await setImmediate();
          expect(remote.signals).toEqual(["SIGTERM", "SIGKILL"]);
          await clock.advanceBy(5_000);
          await expect(disposal).rejects.toThrow("after SIGKILL");
          await expect(output).rejects.toThrow("aborted");
        }),
      { clock: clock.clock },
    );
  } finally {
    await processes.dispose();
    await clock.dispose();
  }
});
