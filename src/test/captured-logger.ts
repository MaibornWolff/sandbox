import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";

/** Run a callback with a logger whose output lines are collected in `messages`. */
export function runWithCapturedLogs<T>(
  messages: string[],
  callback: () => T,
): T {
  const logger = createLogger(
    { now: () => 0, sleep: () => Promise.resolve() },
    (message) => messages.push(message),
    { verbose: true },
  );
  return runWithDependencies([provideLogger(logger)], callback);
}
