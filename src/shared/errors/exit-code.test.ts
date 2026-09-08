import { describe, expect, test } from "bun:test";
import { getErrorExitCode } from "./exit-code.js";

describe("getErrorExitCode", () => {
  test("extracts an exitCode property", () => {
    expect(getErrorExitCode({ exitCode: 130 })).toBe(130);
  });

  test("defaults to 1 without a numeric exit code", () => {
    expect(getErrorExitCode(new Error("failed"))).toBe(1);
    expect(getErrorExitCode({ exitCode: "2" })).toBe(1);
    expect(getErrorExitCode(null)).toBe(1);
  });
});
