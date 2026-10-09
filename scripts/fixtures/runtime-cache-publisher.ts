import "core-js/stable/disposable-stack/index.js";
import "core-js/stable/async-disposable-stack/index.js";
import { createSystemClock, provideClock } from "#platform/clock/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  provideHostEnvironment,
  readProcessEnvironment,
} from "#platform/environment/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import { prepareSandboxRuntimeFromPackage } from "../../src/modules/sandbox-runtime/runtime-cache.js";

async function waitForPublicationRequest(): Promise<void> {
  const requested = new Promise<void>((resolve) => {
    process.once("message", () => resolve());
  });
  process.send?.("ready");
  await requested;
}

async function publishRuntime(
  directory: string,
  version: string,
): Promise<void> {
  const environment = readProcessEnvironment();
  const clock = createSystemClock();
  const logger = createLogger(clock, () => {});

  await runWithDependencies(
    [
      provideHostEnvironment(environment),
      provideClock(clock),
      provideLogger(logger),
    ],
    async () => {
      await using runtime = await prepareSandboxRuntimeFromPackage({
        directory,
        version,
      });
      const result = { id: runtime.id, mount: runtime.mount };
      process.stdout.write(JSON.stringify(result));
    },
  );
}

async function main(): Promise<void> {
  const [directory, version] = process.argv.slice(2);
  if (!directory || !version) {
    throw new Error("Runtime directory and version are required");
  }

  await waitForPublicationRequest();
  await publishRuntime(directory, version);
  process.disconnect?.();
}

if (import.meta.main) {
  await main();
}
