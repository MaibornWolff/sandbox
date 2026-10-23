import { describe, expect, test } from "bun:test";
import type { CheckCommandResult } from "./check.js";
import { runChecks } from "./check.js";

const success = (): CheckCommandResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
});

async function successfulRunSteps(): Promise<string[]> {
  const started: string[] = [];
  await runChecks({
    verbose: false,
    log: () => undefined,
    runStep: async (step) => {
      started.push(step);
      return success();
    },
  });
  return started;
}

describe("check runner", () => {
  test("runs mutating gates before parallel read-only gates and tests last", async () => {
    const started: string[] = [];
    let activeReadOnlySteps = 0;
    let maximumActiveReadOnlySteps = 0;

    const result = await runChecks({
      verbose: false,
      log: () => undefined,
      runStep: async (step) => {
        started.push(step);
        if (step === "lint" || step === "build") return success();
        if (step === "test") {
          expect(activeReadOnlySteps).toBe(0);
          return success();
        }
        activeReadOnlySteps += 1;
        maximumActiveReadOnlySteps = Math.max(
          maximumActiveReadOnlySteps,
          activeReadOnlySteps,
        );
        await Promise.resolve();
        activeReadOnlySteps -= 1;
        return success();
      },
    });

    expect(result.exitCode).toBe(0);
    expect(started.slice(0, 2)).toEqual(["lint", "build"]);
    expect(started.at(-1)).toBe("test");
    expect(maximumActiveReadOnlySteps).toBeGreaterThan(1);
  });

  test("continues through later phases and collects lint failures", async () => {
    const started: string[] = [];

    const result = await runChecks({
      verbose: false,
      log: () => undefined,
      runStep: async (step) => {
        started.push(step);
        return step === "lint" || step === "test"
          ? { ...success(), exitCode: 1 }
          : success();
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.failures.map((failure) => failure.step)).toEqual([
      "lint",
      "test",
    ]);
    expect(started).toEqual(await successfulRunSteps());
  });

  test("collects thrown runner failures and runs every remaining phase", async () => {
    const started: string[] = [];

    const result = await runChecks({
      verbose: false,
      log: () => undefined,
      runStep: async (step) => {
        started.push(step);
        if (step === "lint") throw new Error("lint runner rejected");
        if (step === "build") throw "build runner rejected";
        return success();
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.failures).toEqual([
      {
        step: "lint",
        passed: false,
        output: "Step runner failed: lint runner rejected",
      },
      {
        step: "build",
        passed: false,
        output: "Step runner failed: build runner rejected",
      },
    ]);
    expect(started).toEqual(await successfulRunSteps());
  });

  test("fails when deprecated APIs are reported", async () => {
    const result = await runChecks({
      verbose: false,
      log: () => undefined,
      runStep: async (step) =>
        step === "deprecations"
          ? {
              exitCode: 1,
              stdout: "src/example.ts:3:1: Deprecated API",
              stderr: "",
            }
          : success(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.failures).toMatchObject([
      { step: "deprecations", output: "src/example.ts:3:1: Deprecated API" },
    ]);
  });
});
