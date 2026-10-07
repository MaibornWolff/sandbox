import { expect, test } from "bun:test";
import { createTestClock } from "./__test__/index.js";
import { waitWithTimeout } from "./wait-with-timeout.js";

test.each([false, true])(
  "clears the deadline when the operation fails=%s",
  async (fails) => {
    const clock = createTestClock();
    const completion = Promise.withResolvers<string>();
    const waiting = waitWithTimeout(completion.promise, {
      clock: clock.clock,
      milliseconds: 100,
    });
    expect(clock.pendingSleeps()).toBe(1);
    const failure = new Error("operation failed");
    if (fails) {
      completion.reject(failure);
      await expect(waiting).rejects.toBe(failure);
    } else {
      completion.resolve("complete");
      expect(await waiting).toEqual({ completed: true, value: "complete" });
    }
    expect(clock.pendingSleeps()).toBe(0);
  },
);

test("reports the deadline without cancelling the caller's operation", async () => {
  const clock = createTestClock();
  const completion = Promise.withResolvers<string>();
  const waiting = waitWithTimeout(completion.promise, {
    clock: clock.clock,
    milliseconds: 10,
  });
  await clock.advanceBy(9);
  expect(clock.pendingSleeps()).toBe(1);
  await clock.advanceBy(1);
  expect(await waiting).toEqual({ completed: false });
  expect(clock.pendingSleeps()).toBe(0);
  completion.resolve("late result");
  expect(await completion.promise).toBe("late result");
});

test.each([0, -1])(
  "reports an expired deadline of %i without scheduling a timer",
  async (milliseconds) => {
    const clock = createTestClock();
    const completion = Promise.withResolvers<void>();
    expect(
      await waitWithTimeout(completion.promise, {
        clock: clock.clock,
        milliseconds,
      }),
    ).toEqual({ completed: false });
    expect(clock.pendingSleeps()).toBe(0);
  },
);
