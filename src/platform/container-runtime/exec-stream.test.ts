import { expect, test } from "bun:test";
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
