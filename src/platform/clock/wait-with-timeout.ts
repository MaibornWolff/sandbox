import type { Clock } from "./clock.js";

/** A timeout does not cancel the operation. The caller owns its cancellation. */
export async function waitWithTimeout<T>(
  completion: Promise<T>,
  options: {
    readonly clock: Pick<Clock, "sleep">;
    readonly milliseconds: number;
  },
): Promise<
  | { readonly completed: true; readonly value: T }
  | { readonly completed: false }
> {
  if (options.milliseconds <= 0) return { completed: false };
  const cancellation = new AbortController();
  using _deadline = { [Symbol.dispose]: () => cancellation.abort() };
  return await Promise.race([
    completion.then((value) => ({ completed: true as const, value })),
    options.clock
      .sleep(options.milliseconds, { signal: cancellation.signal })
      .then(() => ({ completed: false as const })),
  ]);
}
