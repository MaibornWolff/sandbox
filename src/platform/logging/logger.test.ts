import { describe, expect, test } from "bun:test";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { stripAnsi } from "#test/utils.js";
import {
  createLineWriter,
  createLogger,
  formatErrorDiagnostics,
  getLogger,
  provideLogger,
} from "./logger.js";

function recording(options: { verbose?: boolean; silent?: boolean } = {}) {
  const clock = createTestClock(1_000);
  const stderr: string[] = [];
  return {
    clock,
    stderr,
    logger: createLogger(clock.clock, (message) => stderr.push(message), {
      ...options,
    }),
  };
}

describe("execution-scoped logger", () => {
  test("creates line-oriented terminal writers", () => {
    const chunks: string[] = [];
    const writer = createLineWriter({
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    });
    writer("message");
    createLineWriter(
      {
        write: (chunk: string) => {
          chunks.push(chunk);
          return true;
        },
      },
      "[container] ",
    )("prefixed");
    expect(chunks).toEqual(["message\n", "[container] prefixed\n"]);
  });

  test("routes diagnostic levels to stderr", () => {
    const value = recording();
    value.logger.success("success");
    value.logger.info("info");
    value.logger.warn("warning");
    value.logger.error("failure");
    const stderr = stripAnsi(value.stderr.join("\n"));
    expect(stderr).toContain("✓ success");
    expect(stderr).toContain("→ info");
    expect(stderr).toContain("⚠ warning");
    expect(stderr).toContain("✗ failure");
  });

  test("can omit local elapsed time from debug output", () => {
    const clock = createTestClock(1_000);
    const output: string[] = [];
    const settings = { verbose: true, showElapsedTime: false };
    const logger = createLogger(
      clock.clock,
      (message) => output.push(message),
      settings,
    );

    logger.debug("container message");

    expect(stripAnsi(output.join("\n"))).toBe("container message");
  });

  test("uses the scoped clock for debug and timing output", async () => {
    const value = recording({ verbose: true });
    value.logger.startTiming("operation");
    await value.clock.advanceBy(25);
    value.logger.debug("progress");
    value.logger.endTiming("operation");
    expect(value.stderr.join("\n")).toContain("[+25ms] progress");
    expect(value.stderr.join("\n")).toContain("operation completed in 25ms");
  });

  test("warns when a timing marker is missing", () => {
    const value = recording({ verbose: true });
    value.logger.endTiming("missing");
    expect(value.stderr.join("\n")).toContain("No timing found for: missing");
  });

  test("keeps verbose and silent state local to each instance", () => {
    const first = recording();
    const second = recording();
    first.logger.setVerbose(true);
    second.logger.setSilent(true);
    first.logger.debug("visible");
    second.logger.info("hidden");
    second.logger.error("still visible");
    expect(first.stderr.join("\n")).toContain("visible");
    expect(second.stderr.join("\n")).toContain("still visible");
  });

  test("suppresses debug and timing unless verbose is enabled", () => {
    const value = recording();
    value.logger.debug("hidden");
    value.logger.startTiming("hidden");
    value.logger.endTiming("hidden");
    expect(value.stderr).toEqual([]);
  });

  test("formats complete recursive causes, aggregates, and suppressed errors once", () => {
    const cause = new Error("nested cause");
    const aggregated = new Error("aggregated cleanup");
    const suppressed = new Error("suppressed disposal");
    const primary = new Error("primary failure", {
      cause: new AggregateError([cause, aggregated], "combined cause"),
    }) as Error & { suppressedErrors: readonly unknown[] };
    primary.suppressedErrors = [suppressed, cause];

    const output = formatErrorDiagnostics(primary);

    for (const error of [primary, cause, aggregated, suppressed]) {
      expect(output).toContain(error.stack as string);
      expect(output.split(error.stack as string)).toHaveLength(2);
    }
    expect(output).toContain("Caused by: AggregateError: combined cause");
    expect(output).toContain("Aggregated error:");
    expect(output).toContain("Suppressed error:");
  });

  test("resolves only the logger in the active concurrent scope", async () => {
    const first = recording();
    const second = recording();
    const resolved = await Promise.all([
      runWithDependencies([provideLogger(first.logger)], async () => {
        await Promise.resolve();
        return getLogger();
      }),
      runWithDependencies([provideLogger(second.logger)], async () => {
        await Promise.resolve();
        return getLogger();
      }),
    ]);
    expect(resolved).toEqual([first.logger, second.logger]);
    expect(() => getLogger()).toThrow(
      'Dependency "logger" is not registered in the active scope.',
    );
  });
});
