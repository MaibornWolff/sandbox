import { addAbortListener } from "node:events";
import { getClock } from "#platform/clock/index.js";

const HEARTBEAT_TIMEOUT_MS = 5_000;

export function createControlWatchdog(
  initialTimeoutMs: number,
  signal?: AbortSignal,
) {
  const deadline = Promise.withResolvers<void>();
  const clock = getClock();
  let timer = new AbortController();
  let disposed = false;
  function arm(milliseconds: number) {
    if (disposed) return;
    timer.abort();
    timer = new AbortController();
    void clock
      .sleep(milliseconds, { signal: timer.signal })
      .then(deadline.resolve, () => undefined);
  }
  arm(initialTimeoutMs);
  const cancellation =
    signal && addAbortListener(signal, () => deadline.reject(signal.reason));
  return {
    expired: deadline.promise,
    pulse: (milliseconds = HEARTBEAT_TIMEOUT_MS) => arm(milliseconds),
    [Symbol.dispose]() {
      disposed = true;
      timer.abort();
      cancellation?.[Symbol.dispose]();
    },
  };
}

export async function readControlLines(
  stream: AsyncIterable<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  let pending = "";
  for await (const bytes of stream) {
    pending += Buffer.from(bytes).toString("utf8");
    let separator = pending.indexOf("\n");
    while (separator >= 0) {
      if (separator > 16_384)
        throw new Error("Container session control output exceeded its limit.");
      onLine(pending.slice(0, separator));
      pending = pending.slice(separator + 1);
      separator = pending.indexOf("\n");
    }
    if (pending.length > 16_384)
      throw new Error("Container session control output exceeded its limit.");
  }
  if (pending) onLine(pending);
}
