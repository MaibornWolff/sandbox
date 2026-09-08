import { createSystemClock, provideClock } from "#platform/clock/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createHostEnvironment,
  provideHostEnvironment,
} from "#platform/environment/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";

export function runWithConfigurationTestScope<T>(
  callback: () => T,
  options: {
    readonly currentWorkingDirectory?: string;
    readonly homeDirectory?: string;
    readonly variables?: Readonly<Record<string, string>>;
    readonly platform?: NodeJS.Platform;
  } = {},
): T {
  const clock = createSystemClock();
  return runWithDependencies(
    [
      provideClock(clock),
      provideHostEnvironment(
        createHostEnvironment({
          currentWorkingDirectory:
            options.currentWorkingDirectory ?? "/project",
          homeDirectory: options.homeDirectory ?? "/home/test",
          variables: options.variables ?? {},
          platform: options.platform ?? "linux",
          interactive: false,
        }),
      ),
      provideLogger(createLogger(clock, () => undefined)),
    ],
    callback,
  );
}
