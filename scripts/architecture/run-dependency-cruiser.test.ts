import { describe, expect, test } from "bun:test";
import { validateCruiseResult } from "./run-dependency-cruiser.mjs";

describe("dependency-cruiser runner", () => {
  test("rejects an invalid dependency-cruiser result", () => {
    expect(() => validateCruiseResult({ modules: [] })).toThrow(
      "dependency-cruiser returned an invalid result",
    );
  });
});
