import { describe, expect, test } from "bun:test";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createTestClock } from "./__test__/index.js";
import { createSystemClock, getClock, provideClock } from "./index.js";

describe("clock dependency", () => {
  test("requires an active scope", () => {
    expect(() => getClock()).toThrow(
      'Dependency "clock" is not registered in the active scope.',
    );
  });

  test("system clock sleeps and supports cancellation", async () => {
    const clock = createSystemClock();
    const before = clock.now();
    await clock.sleep(1);
    expect(clock.now()).toBeGreaterThanOrEqual(before);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      clock.sleep(10, { signal: alreadyAborted.signal }),
    ).rejects.toThrow("aborted");

    const controller = new AbortController();
    const sleeping = clock.sleep(10_000, { signal: controller.signal });
    controller.abort();
    await expect(sleeping).rejects.toThrow("aborted");
  });

  test("isolates parallel clock scopes", async () => {
    const first = createTestClock(10);
    const second = createTestClock(20);
    const values = await Promise.all([
      runWithDependencies([provideClock(first.clock)], async () => {
        await Promise.resolve();
        return getClock().now();
      }),
      runWithDependencies([provideClock(second.clock)], async () => {
        await Promise.resolve();
        return getClock().now();
      }),
    ]);
    expect(values).toEqual([10, 20]);
  });
});
