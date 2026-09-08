import {
  createDependency,
  type DependencyBinding,
} from "#platform/dependency-injection/index.js";

export interface Clock {
  now(): number;
  sleep(
    milliseconds: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
}

const clockDependency = createDependency<Clock>("clock");

export function provideClock(clock: Clock): DependencyBinding {
  return clockDependency.provide(clock);
}

export function getClock(): Clock {
  return clockDependency.get();
}

export function createSystemClock(): Clock {
  return {
    now: () => Date.now(),
    sleep(milliseconds, options = {}) {
      return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(
            options.signal.reason ??
              new DOMException("The operation was aborted", "AbortError"),
          );
          return;
        }
        const timeout = setTimeout(finish, milliseconds);
        const abort = () => {
          clearTimeout(timeout);
          cleanup();
          reject(
            options.signal?.reason ??
              new DOMException("The operation was aborted", "AbortError"),
          );
        };
        function cleanup() {
          options.signal?.removeEventListener("abort", abort);
        }
        function finish() {
          cleanup();
          resolve();
        }
        options.signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
}
