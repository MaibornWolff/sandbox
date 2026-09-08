import { describe, expect, test } from "bun:test";
import type { CheckCommandResult } from "./check.js";
import { runChecks } from "./check.js";

const success = (): CheckCommandResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
});

function thresholdViolation(): CheckCommandResult {
  return {
    exitCode: 1,
    stdout: "Coverage threshold not met",
    stderr: "",
  };
}

describe("check runner", () => {
  test("runs mutating gates before parallel read-only gates and coverage last", async () => {
    const started: string[] = [];
    let activeReadOnlySteps = 0;
    let maximumActiveReadOnlySteps = 0;

    const result = await runChecks({
      verbose: false,
      log: () => undefined,
      runStep: async (step) => {
        started.push(step);
        if (step === "lint" || step === "build") return success();
        if (step === "coverage:check") {
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
    expect(started.at(-1)).toBe("coverage:check");
    expect(maximumActiveReadOnlySteps).toBeGreaterThan(1);
  });

  test("continues through later phases and collects lint failures", async () => {
    const started: string[] = [];

    const result = await runChecks({
      verbose: false,
      log: () => undefined,
      runStep: async (step) => {
        started.push(step);
        return step === "lint" || step === "coverage:check"
          ? { ...success(), exitCode: 1 }
          : success();
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.failures.map((failure) => failure.step)).toEqual([
      "lint",
      "coverage:check",
    ]);
    expect(started).toEqual([
      "lint",
      "build",
      "typecheck",
      "architecture",
      "cpd",
      "knip",
      "test:scripts",
      "coverage:check",
    ]);
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
    expect(started).toEqual([
      "lint",
      "build",
      "typecheck",
      "architecture",
      "cpd",
      "knip",
      "test:scripts",
      "coverage:check",
    ]);
    expect(started.at(-1)).toBe("coverage:check");
  });

  test("fails through the coverage gate path", async () => {
    const result = await runChecks({
      verbose: false,
      log: () => undefined,
      runStep: async (step) =>
        step === "coverage:check" ? thresholdViolation() : success(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.failures.map((failure) => failure.step)).toEqual([
      "coverage:check",
    ]);
  });
});
