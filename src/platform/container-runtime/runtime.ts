import { getLogger } from "#platform/logging/index.js";
import { DockerService } from "./docker/service.js";
import type { RuntimeExecutor } from "./executor.js";
import { PodmanService } from "./podman/service.js";
import { RUNTIMES, type Runtime } from "./runtime-types.js";
import type { ContainerRuntime } from "./types.js";

/**
 * Auto-detect which container runtime is available.
 *
 * Tries docker, then podman.
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
      const service = createRuntimeService(runtime, exec);
      const version = await service.getVersion();
      logger.debug(`Detected ${runtime}: ${version}`);
      logger.endTiming("Resolve runtime");
      return runtime;
    } catch {
      logger.debug(`${runtime} not found`);
    }
  }

  logger.endTiming("Resolve runtime");
  throw new Error(
    "No container runtime found. Please install Docker or Podman.",
  );
}

/** Create a ContainerRuntime for the given runtime. */
export function createRuntimeService(
  runtime: Runtime,
  exec: RuntimeExecutor,
): ContainerRuntime {
  switch (runtime) {
    case "docker":
      return new DockerService(exec);
    case "podman":
      return new PodmanService(exec);
    default: {
      const _exhaustive: never = runtime;
      throw new Error(`Unknown runtime: ${_exhaustive}`);
    }
  }
}
