import { getLogger } from "#platform/logging/index.js";
import { AppleContainerService } from "./apple/service.js";
import { DockerService } from "./docker/service.js";
import type { RuntimeExecutor } from "./executor.js";
import { PodmanService } from "./podman/service.js";
import {
  type ContainerRuntimeOptions,
  DEFAULT_CONTAINER_RUNTIME_OPTIONS,
} from "./runtime-options.js";
import { RUNTIMES, type Runtime } from "./runtime-types.js";
import type { SandboxRuntimeSelection } from "./sandbox-contract.js";

/**
 * Auto-detect which container runtime is available.
 *
 * Tries Docker, then Podman, then Apple container.
 * If `configRuntime` is provided and valid, uses that directly.
 */
export async function resolveRuntime(
  configRuntime: string | undefined,
  exec: RuntimeExecutor,
): Promise<Runtime> {
  const logger = getLogger();
  logger.startTiming("Resolve runtime");

  if (configRuntime && RUNTIMES.includes(configRuntime as Runtime)) {
    logger.debug(`Using configured runtime: ${configRuntime}`);
    logger.endTiming("Resolve runtime");
    return configRuntime as Runtime;
  }

  logger.debug("Auto-detecting container runtime...");

  for (const runtime of RUNTIMES) {
    try {
      const binaryName = runtime === "apple-container" ? "container" : runtime;
      const version = (await exec(binaryName, ["--version"])).trim();
      logger.debug(`Detected ${runtime}: ${version}`);
      logger.endTiming("Resolve runtime");
      return runtime;
    } catch {
      logger.debug(`${runtime} not found`);
    }
  }

  logger.endTiming("Resolve runtime");
  throw new Error(
    "No container runtime found. Install Docker, Podman, or Apple container.",
  );
}

/** Create the runtime and compatible image builder for a selected runtime. */
export function createRuntimeService(
  runtime: Runtime,
  exec: RuntimeExecutor,
  options: ContainerRuntimeOptions = DEFAULT_CONTAINER_RUNTIME_OPTIONS,
): SandboxRuntimeSelection {
  const adapter = (() => {
    switch (runtime) {
      case "docker":
        return new DockerService(exec);
      case "podman":
        return new PodmanService(exec);
      case "apple-container":
        return new AppleContainerService(exec, options["apple-container"]);
      default: {
        const _exhaustive: never = runtime;
        throw new Error(`Unknown runtime: ${_exhaustive}`);
      }
    }
  })();
  return {
    runtime: adapter,
    imageBuilder: adapter,
    imageOwnershipKey: runtime,
  };
}
