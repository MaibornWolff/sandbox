import { getClock } from "#platform/clock/index.js";
import type { WebSocketConnection } from "#platform/websocket/index.js";
import { OPERATION_TIMEOUT } from "./protocol.js";

export async function withClipboardDeadline<T>(
  connection: WebSocketConnection,
  parent: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const signal = AbortSignal.any([parent, deadline.signal]);
  const stopTimer = new AbortController();
  const close = () => {
    void connection.close(1000, "Clipboard request ended");
  };
  signal.addEventListener("abort", close, { once: true });
  using _listener = {
    [Symbol.dispose]() {
      signal.removeEventListener("abort", close);
      stopTimer.abort();
    },
  };
  const timer = getClock()
    .sleep(OPERATION_TIMEOUT, { signal: stopTimer.signal })
    .then(
      () => deadline.abort(),
      () => {},
    );
  await using _timer = {
    async [Symbol.asyncDispose]() {
      stopTimer.abort();
      await timer;
    },
  };
  signal.throwIfAborted();
  return await operation(signal);
}

export const MAX_CONCURRENT_TRANSFERS = 4;

export function createSlotLimiter(
  max: number,
  createBusyError: () => Error,
): () => Disposable {
  let active = 0;
  return () => {
    if (active >= max) throw createBusyError();
    active++;
    return {
      [Symbol.dispose]() {
        active--;
      },
    };
  };
}
