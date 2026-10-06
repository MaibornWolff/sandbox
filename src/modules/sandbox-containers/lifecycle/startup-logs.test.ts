import { expect, test } from "bun:test";
import { getClock } from "#platform/clock/index.js";
import { createStatefulContainerRuntimeHarness } from "#platform/container-runtime/__test__/index.js";
import type { CommandResult } from "#platform/container-runtime/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { captureStartupLogs } from "./startup-logs.js";

test.each([true, false])(
  "bounds long logs with subsequent lines=%s",
  async (subsequentLines) => {
    const harness = createStatefulContainerRuntimeHarness();
    const runtime = (await harness.provider.resolve()).runtime;
    await runWithTestLogger(async () => {
      const output: string[] = [];
      const logger = createLogger(getClock(), (message) =>
        output.push(message),
      );
      await runWithDependencies([provideLogger(logger)], async () => {
        await using capture = captureStartupLogs(
          {
            ...runtime,
            instances: {
              ...runtime.instances,
              followLogs: (_id, options) => {
                options.onOutput(
                  Buffer.from(
                    Array.from({ length: 201 }, (_, i) => `line-${i}\n`).join(
                      "",
                    ),
                  ),
                );
                for (let i = 0; i < 100; i++)
                  options.onOutput(Buffer.alloc(16_384, "x"));
                if (subsequentLines) {
                  options.onOutput(Buffer.from("\nnext\n"));
                  const unicode = Buffer.from("€");
                  options.onOutput(unicode.subarray(0, 1));
                  options.onOutput(unicode.subarray(1));
                }
                const completion = Promise.resolve({
                  exitCode: 0,
                  stdout: "",
                  stderr: "",
                });
                const stop = async () => {};
                return { completion, stop, [Symbol.asyncDispose]: stop };
              },
            },
          },
          "sandbox-project",
        );
        await capture.stop();
        capture.reportFailure();
        const report = output.join("\n");
        expect(report).toContain(
          `Container startup logs for sandbox-project:\nline-${subsequentLines ? 4 : 2}\n`,
        );
        expect(report).toContain(
          `${"x".repeat(16_384)} [truncated]${subsequentLines ? "\nnext\n€" : ""}`,
        );
        expect(report).not.toContain("line-0\n");
        expect(report.length).toBeLessThan(20_000);
      });
    });
  },
);

test("stops startup log capture once when explicitly stopped and disposed", async () => {
  const harness = createStatefulContainerRuntimeHarness();
  const runtime = (await harness.provider.resolve()).runtime;
  let stops = 0;
  await runWithTestLogger(async () => {
    await using capture = captureStartupLogs(
      {
        ...runtime,
        instances: {
          ...runtime.instances,
          followLogs: (_id, options) => {
            options.onOutput(Buffer.from("partial startup line"));
            const completion = Promise.withResolvers<CommandResult>();
            const stop = async () => {
              stops++;
              completion.resolve({ exitCode: 0, stdout: "", stderr: "" });
            };
            return {
              completion: completion.promise,
              stop,
              [Symbol.asyncDispose]: stop,
            };
          },
        },
      },
      "sandbox-project",
    );
    await Promise.all([capture.stop(), capture.stop()]);
    capture.reportFailure();
  });
  expect(stops).toBe(1);
});
