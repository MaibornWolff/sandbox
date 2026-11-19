import { describe, expect, test } from "bun:test";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { getContainerUptime } from "./container-status.js";

const NOW = Date.UTC(2026, 0, 1);

function uptime(secondsAgo: number | null): string {
  return runWithTestLogger(
    () =>
      getContainerUptime(
        secondsAgo === null ? null : new Date(NOW - secondsAgo * 1_000),
      ),
    { clock: createTestClock(NOW).clock },
  );
}

describe("getContainerUptime", () => {
  test("uses the singular unit for a value of 1", () => {
    expect(uptime(1)).toBe("Up 1 second");
    expect(uptime(60)).toBe("Up 1 minute");
    expect(uptime(3_600)).toBe("Up 1 hour");
    expect(uptime(86_400)).toBe("Up 1 day");
  });

  test("uses the plural unit for other values", () => {
    expect(uptime(0)).toBe("Up 0 seconds");
    expect(uptime(150)).toBe("Up 2 minutes");
    expect(uptime(7_200)).toBe("Up 2 hours");
    expect(uptime(172_800)).toBe("Up 2 days");
  });

  test("shows unknown without a start time", () => {
    expect(uptime(null)).toBe("unknown");
  });
});
