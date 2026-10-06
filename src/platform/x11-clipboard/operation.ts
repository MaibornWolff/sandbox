import { addAbortListener } from "node:events";
import { type Clock, waitWithTimeout } from "#platform/clock/index.js";

/** Error with a short code. Services prefix it with `display-` or `transfer-`. */
export class X11Error extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function x11Error(code: string, message: string): X11Error {
  return new X11Error(code, message);
}

export async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort: (error: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  using _abort = addAbortListener(signal, () => rejectAbort(signal.reason));
  return await Promise.race([operation, aborted]);
}

export async function deadline<T>(options: {
  clock: Clock;
  signal: AbortSignal;
  milliseconds: number;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  using _cancel = { [Symbol.dispose]: () => controller.abort() };
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const result = await waitWithTimeout(
    abortable(options.run(signal), signal),
    options,
  );
  if (!result.completed)
    throw x11Error("timeout", "Private X11 operation timed out");
  return result.value;
}
