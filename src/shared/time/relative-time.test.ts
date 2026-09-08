import { describe, expect, test } from "bun:test";
import { formatRelativeTime } from "./relative-time.js";

const now = Date.UTC(2026, 0, 27, 12);

const cases: readonly [number, string][] = [
  [0, "0s ago"],
  [1_000, "1s ago"],
  [30_000, "30s ago"],
  [59_900, "59s ago"],
  [60_000, "1m ago"],
  [5 * 60_000, "5m ago"],
  [59 * 60_000, "59m ago"],
  [(2 * 60 + 30) * 1_000, "2m ago"],
  [3_600_000, "1h ago"],
  [12 * 3_600_000, "12h ago"],
  [23 * 3_600_000, "23h ago"],
  [(3 * 3_600 + 1_800) * 1_000, "3h ago"],
  [86_400_000, "1d ago"],
  [7 * 86_400_000, "7d ago"],
  [30 * 86_400_000, "30d ago"],
  [(2 * 86_400 + 43_200) * 1_000, "2d ago"],
  [3_599_000, "59m ago"],
  [86_399_000, "23h ago"],
];

describe("formatRelativeTime", () => {
  for (const [elapsed, expected] of cases) {
    test(`formats ${elapsed}ms`, () => {
      expect(formatRelativeTime(now - elapsed, now)).toBe(expected);
    });
  }
});
