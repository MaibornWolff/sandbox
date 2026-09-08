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

  test("advances ordered and nested sleeps deterministically", async () => {
    const testClock = createTestClock(1_000);
    const events: string[] = [];
    await runWithDependencies([provideClock(testClock.clock)], async () => {
      const later = getClock()
        .sleep(20)
        .then(async () => {
          events.push("later");
          await getClock().sleep(5);
          events.push("nested");
        });
      const earlier = getClock()
        .sleep(10)
        .then(() => events.push("earlier"));
      expect(getClock().now()).toBe(1_000);
      await testClock.advanceBy(20);
      expect(events).toEqual(["earlier", "later"]);
      await testClock.advanceBy(5);
      await Promise.all([earlier, later]);
    });
    expect(events).toEqual(["earlier", "later", "nested"]);
    expect(testClock.pendingSleeps()).toBe(0);
  });

  test("rejects cancelled sleeps and removes pending work", async () => {
    const testClock = createTestClock();
    const controller = new AbortController();
    const sleeping = testClock.clock.sleep(10, { signal: controller.signal });
    controller.abort();
    await expect(sleeping).rejects.toThrow("aborted");
    expect(testClock.pendingSleeps()).toBe(0);
  });

  test("disposal rejects pending sleeps and waiters, then rejects new work", async () => {
    const sleepingClock = createTestClock();
    const pendingSleep = sleepingClock.clock.sleep(10);
    const pendingFailure = pendingSleep.catch((error: unknown) => error);
    await sleepingClock.dispose();

    expect(await pendingFailure).toBeInstanceOf(DOMException);
    await expect(sleepingClock.clock.sleep(1)).rejects.toThrow("disposed");
    await expect(sleepingClock.waitForSleep()).rejects.toThrow("disposed");
    expect(sleepingClock.pendingSleeps()).toBe(0);
    await expect(sleepingClock.dispose()).resolves.toBeUndefined();

    const waitingClock = createTestClock();
    const sleepWaiter = waitingClock.waitForSleep();
    const waiterFailure = sleepWaiter.catch((error: unknown) => error);
    await waitingClock.dispose();
    expect(await waiterFailure).toBeInstanceOf(DOMException);
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

  test("advances to the next ordered sleep and rejects when none remain", async () => {
    const testClock = createTestClock();
    const later = testClock.clock.sleep(20);
    const earlier = testClock.clock.sleep(10);

    await testClock.advanceToNext();
    await earlier;
    expect(testClock.currentTime()).toBe(10);
    expect(testClock.pendingSleeps()).toBe(1);

    await testClock.advanceToNext();
    await later;
    await expect(testClock.advanceToNext()).rejects.toThrow("no pending sleep");
  });

  test("rejects invalid deterministic advancement", async () => {
    const testClock = createTestClock(10);
    expect(testClock.currentTime()).toBe(10);
    const controller = new AbortController();
    controller.abort();
    await expect(
      testClock.clock.sleep(1, { signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(() => testClock.advanceTo(9)).toThrow("cannot move backwards");
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
