import { expect, test } from "bun:test";
import { AsyncResource } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { HOOK_PULSE } from "#modules/sandbox-hooks/index.js";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { createStatefulContainerRuntimeHarness } from "#platform/container-runtime/__test__/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { runSessionHooks } from "./session-hooks.js";

test.each([
  {
    title: "force arrives while the end event is active",
    alreadyForced: false,
  },
  { title: "the end event begins after force", alreadyForced: true },
])(
  "shares one end-hook grace period when $title",
  async ({ alreadyForced }) => {
    using resources = new DisposableStack();
    const signalDispatch = new AsyncResource("signal-dispatch", {
      requireManualDestroy: true,
    });
    resources.defer(() => signalDispatch.emitDestroy());
    const clock = createTestClock();
    const processes = createProcessTestHarness(clock.clock);
    const containers = createStatefulContainerRuntimeHarness();
    containers.instances.create({
      name: "target",
      image: "image",
      labels: {},
      status: "running",
    });
    const { runtime } = await containers.provider.resolve();
    const third = processes.expectStart({
      match: { argsInclude: "__run-hook" },
    });
    const second = processes.expectStart({
      match: { argsInclude: "__run-hook" },
    });
    const first = processes.expectStart({
      match: { argsInclude: "__run-hook" },
    });

    await runWithTestLogger(
      () =>
        processes.run(async () => {
          try {
            void processes.manager.termination;
            processes.emitTermination("SIGHUP");
            if (alreadyForced) {
              processes.emitTermination("SIGHUP");
              await clock.advanceBy(6_000);
            }
            const hooks = runSessionHooks({
              containers: runtime.instances,
              containerId: "target",
              spec: { command: ["attached-command"] },
              event: "session.end",
              hooks: ["first", "second", "third"].map((command) => ({
                event: "session.end",
                command: [command],
                wait: true,
                timeoutMs: 60_000,
              })),
            });
            void hooks.catch(() => undefined);
            const pulse = async (launcher: typeof first) => {
              launcher.emitStdout(`${HOOK_PULSE}\n`);
              await setImmediate();
              await clock.advanceBy(1_000);
            };

            await first.waitForStart();
            if (!alreadyForced) {
              for (let elapsed = 0; elapsed < 6; elapsed += 1)
                await pulse(first);
              expect(second.pid).toBeUndefined();
              signalDispatch.runInAsyncScope(() =>
                processes.emitTermination("SIGHUP"),
              );
            }
            for (let elapsed = 0; elapsed < 3; elapsed += 1) await pulse(first);
            expect(first.signals).toEqual([]);
            first.emitStdout("ok\n");
            first.exit();
            await second.waitForStart();
            let leaseClosed = false;
            void second.waitForInputEnd().then(
              () => {
                leaseClosed = true;
              },
              () => undefined,
            );
            await pulse(second);
            expect(leaseClosed).toBe(false);
            await pulse(second);
            await second.waitForInputEnd();
            expect(second.signals).toEqual([]);
            second.exit();
            await expect(hooks).rejects.toThrow(
              "timed out during forced shutdown",
            );
            expect(third.pid).toBeUndefined();
          } finally {
            await processes.dispose();
            await clock.dispose();
          }
        }),
      { clock: clock.clock },
    );
  },
);
