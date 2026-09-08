import type { Clock } from "../clock.js";

interface PendingSleep {
  readonly due: number;
  readonly sequence: number;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
}

function createPendingSleep(options: {
  readonly due: number;
  readonly sequence: number;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  readonly pending: Set<PendingSleep>;
}): PendingSleep {
  const { signal } = options;
  const item: PendingSleep = {
    due: options.due,
    sequence: options.sequence,
    resolve: options.resolve,
    reject: options.reject,
    ...(signal ? { signal } : {}),
    ...(signal
      ? {
          abort: () => {
            options.pending.delete(item);
            options.reject(
              signal.reason ??
                new DOMException("The operation was aborted", "AbortError"),
            );
          },
        }
      : {}),
  };
  return item;
}

export interface TestClock {
  readonly clock: Clock;
  currentTime(): number;
  advanceBy(milliseconds: number): Promise<void>;
  advanceTo(timestamp: number): Promise<void>;
  advanceToNext(): Promise<void>;
  waitForSleep(): Promise<void>;
  pendingSleeps(): number;
  dispose(): Promise<void>;
}

export function createTestClock(initialTime = 0): TestClock {
  let now = initialTime;
  let sequence = 0;
  let disposed = false;
  const pending = new Set<PendingSleep>();
  const sleepWaiters = new Set<{
    readonly resolve: () => void;
    readonly reject: (reason: unknown) => void;
  }>();

  function disposalError(): DOMException {
    return new DOMException("The test clock was disposed", "AbortError");
  }

  function notifySleepWaiters(): void {
    for (const waiter of sleepWaiters) waiter.resolve();
    sleepWaiters.clear();
  }

  async function settleDue(target: number): Promise<void> {
    while (true) {
      const next = [...pending]
        .filter((sleep) => sleep.due <= target)
        .sort(
          (first, second) =>
            first.due - second.due || first.sequence - second.sequence,
        )[0];
      if (!next) break;
      now = next.due;
      pending.delete(next);
      if (next.abort) next.signal?.removeEventListener("abort", next.abort);
      next.resolve();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  }

  const clock: Clock = {
    now: () => now,
    sleep(milliseconds, options = {}) {
      return new Promise((resolve, reject) => {
        if (disposed) {
          reject(disposalError());
          return;
        }
        if (options.signal?.aborted) {
          reject(
            options.signal.reason ??
              new DOMException("The operation was aborted", "AbortError"),
          );
          return;
        }
        const item = createPendingSleep({
          due: now + milliseconds,
          sequence: sequence++,
          resolve,
          reject,
          ...(options.signal ? { signal: options.signal } : {}),
          pending,
        });
        pending.add(item);
        notifySleepWaiters();
        if (item.abort)
          options.signal?.addEventListener("abort", item.abort, { once: true });
      });
    },
  };

  return {
    clock,
    currentTime: () => now,
    advanceBy: (milliseconds) => settleDue(now + milliseconds),
    advanceTo(timestamp) {
      if (timestamp < now) throw new Error("Test clock cannot move backwards.");
      return settleDue(timestamp);
    },
    async advanceToNext() {
      const next = [...pending].sort(
        (first, second) =>
          first.due - second.due || first.sequence - second.sequence,
      )[0];
      if (!next) throw new Error("The test clock has no pending sleep.");
      await settleDue(next.due);
    },
    waitForSleep() {
      if (pending.size > 0) return Promise.resolve();
      if (disposed) return Promise.reject(disposalError());
      return new Promise((resolve, reject) => {
        sleepWaiters.add({ resolve, reject });
      });
    },
    pendingSleeps: () => pending.size,
    async dispose() {
      if (disposed) return;
      disposed = true;
      const error = disposalError();
      for (const sleep of pending) {
        if (sleep.abort)
          sleep.signal?.removeEventListener("abort", sleep.abort);
        sleep.reject(error);
      }
      pending.clear();
      for (const waiter of sleepWaiters) waiter.reject(error);
      sleepWaiters.clear();
      await Promise.resolve();
    },
  };
}
