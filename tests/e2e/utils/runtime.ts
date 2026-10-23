import {
  getGlobalConfigPath,
  loadTomlConfig,
} from "#modules/configuration/index.js";
import { createSystemClock } from "#platform/clock/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  provideHostEnvironment,
  readProcessEnvironment,
} from "#platform/environment/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";

export function getE2eRuntime(): string | undefined {
  if (process.env.SANDBOX_TEST_RUNTIME !== undefined) {
    return process.env.SANDBOX_TEST_RUNTIME;
  }
  return runWithDependencies(
    [
      provideHostEnvironment(readProcessEnvironment()),
      provideLogger(createLogger(createSystemClock(), console.error)),
    ],
    () => loadTomlConfig(getGlobalConfigPath())?.runtime,
  );
}
