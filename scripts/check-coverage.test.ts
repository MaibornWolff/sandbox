import { describe, expect, test } from "bun:test";
import { calculateLineCoverage } from "./check-coverage.js";

const record = (found: number, hit: number) =>
  `SF:src/file.ts\nLF:${found}\nLH:${hit}\nend_of_record\n`;

describe("coverage check", () => {
  test("calculates aggregate line coverage across LCOV records", () => {
    expect(calculateLineCoverage(record(80, 76) + record(20, 19))).toBe(95);
  });

  test("rejects missing and inconsistent LCOV totals", () => {
    expect(() => calculateLineCoverage("")).toThrow(
      "LCOV report contains no LF records.",
    );
    expect(() => calculateLineCoverage(record(1, 2))).toThrow(
      "LCOV lines hit exceeds lines found.",
    );
  });
});
