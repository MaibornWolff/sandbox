import { getClock, waitWithTimeout } from "#platform/clock/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { getLogger } from "#platform/logging/index.js";
import { AppleContainerService } from "./apple/service.js";
import { DockerService } from "./docker/service.js";
import type { RuntimeExecutor } from "./executor.js";
import { RuntimeHostNotReadyError } from "./host-readiness.js";
import { PodmanService } from "./podman/service.js";
import {
  type ContainerRuntimeOptions,
  DEFAULT_CONTAINER_RUNTIME_OPTIONS,
} from "./runtime-options.js";
import { RUNTIMES, type Runtime, type RuntimeProbe } from "./runtime-types.js";
import type { SandboxRuntimeSelection } from "./sandbox-contract.js";

/** Time limit for probing one runtime, so a stuck daemon or VM cannot block. */
const RUNTIME_PROBE_TIMEOUT_MS = 5_000;

function getBinaryName(runtime: Runtime): string {
  return runtime === "apple-container" ? "container" : runtime;
}

/** Runtimes that the host supports, in `RUNTIMES` order. */
function getHostRuntimes(): readonly Runtime[] {
  const isMacOs = getHostEnvironment().platform === "darwin";
  return RUNTIMES.filter((runtime) => runtime !== "apple-container" || isMacOs);
}

interface RuntimeProbeAttempt {
  readonly probe: RuntimeProbe;
  /** The ready service of a running runtime, for reuse after selection. */
  readonly selection?: SandboxRuntimeSelection;
}

async function probeRuntime(
  runtime: Runtime,
  exec: RuntimeExecutor,
  options: ContainerRuntimeOptions,
  stop?: AbortSignal,
): Promise<RuntimeProbeAttempt> {
  const logger = getLogger();
  const binaryName = getBinaryName(runtime);
  const cancellation = new AbortController();
  const stopProbe = () => cancellation.abort(stop?.reason);
  stop?.addEventListener("abort", stopProbe, { once: true });
  let probing = true;
  let versionOutput: Promise<string> | undefined;
  // Commands use the probe signal only while the probe runs, so a selected
  // service stays usable. The probe and the host check share `--version`.
  const probeExec: RuntimeExecutor = (command, args, execOptions) => {
    if (!probing) return exec(command, args, execOptions);
    const run = () =>
      exec(command, args, { ...execOptions, signal: cancellation.signal });
    if (
      command === binaryName &&
      args?.length === 1 &&
      args[0] === "--version"
    ) {
      versionOutput ??= run();
      return versionOutput;
    }
    return run();
  };
  let version: string | undefined;

  const check = async (): Promise<RuntimeProbeAttempt> => {
    try {
      version = (await probeExec(binaryName, ["--version"])).trim();
    } catch {
      logger.debug(`${runtime} is not installed`);
      return { probe: { runtime, status: "not-installed" } };
    }
    try {
      const selection = createRuntimeService(runtime, probeExec, options);
      const info = await selection.runtime.ensureHostReady();
      logger.debug(`${runtime} is running: ${info.version}`);
      return {
        probe: { runtime, status: "running", version: info.version },
        selection,
      };
    } catch (error) {
      logger.debug(
        `${runtime} is not running: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        probe: {
          runtime,
          status: "not-running",
          version,
          ...(error instanceof RuntimeHostNotReadyError
            ? { hint: error.hint }
            : {}),
        },
      };
    }
  };

  try {
    const result = await waitWithTimeout(check(), {
      clock: getClock(),
      milliseconds: RUNTIME_PROBE_TIMEOUT_MS,
    });
    if (result.completed) {
      if (result.value.selection) probing = false;
      return result.value;
    }
  } finally {
    stop?.removeEventListener("abort", stopProbe);
  }
  cancellation.abort(
    new Error(
      `${runtime} probe timed out after ${RUNTIME_PROBE_TIMEOUT_MS} ms.`,
    ),
  );
  logger.debug(
    `${runtime} probe timed out after ${RUNTIME_PROBE_TIMEOUT_MS} ms`,
  );
  return {
    probe: {
      runtime,
      status: "not-running",
      ...(version === undefined ? {} : { version }),
    },
  };
}

/**
 * Probe all runtimes that the host supports, in parallel and in `RUNTIMES` order.
 *
 * Apple container is left out on hosts other than macOS.
 */
export async function probeRuntimes(
  exec: RuntimeExecutor,
): Promise<readonly RuntimeProbe[]> {
  const attempts = await Promise.all(
    getHostRuntimes().map((runtime) =>
      probeRuntime(runtime, exec, DEFAULT_CONTAINER_RUNTIME_OPTIONS),
    ),
  );
  return attempts.map(({ probe }) => probe);
}

/**
 * Probe the runtimes in parallel and select the first running runtime in
 * `RUNTIMES` order as soon as all earlier runtimes are known not to run.
 * Cancels the remaining probes and reuses the ready service of the selection.
 */
async function detectRuntime(
  exec: RuntimeExecutor,
  options: ContainerRuntimeOptions,
): Promise<SandboxRuntimeSelection> {
  const logger = getLogger();
  const stop = new AbortController();
  const attempts = getHostRuntimes().map((runtime) =>
    probeRuntime(runtime, exec, options, stop.signal),
  );
  const stopped: RuntimeProbe[] = [];
  let running: RuntimeProbeAttempt | undefined;
  for (const attempt of attempts) {
    const result = await attempt;
    if (result.selection) {
      running = result;
      break;
    }
    stopped.push(result.probe);
  }
  stop.abort(new Error("Runtime auto-detection is complete."));
  await Promise.all(attempts);

  if (running?.selection) {
    logger.debug(`Selected running runtime: ${running.probe.runtime}`);
    return running.selection;
  }
  const fallback = stopped.find((probe) => probe.status === "not-running");
  if (fallback) {
    logger.debug(
      `No runtime is running. Selected installed runtime: ${fallback.runtime}`,
    );
    return createRuntimeService(fallback.runtime, exec, options);
  }

  throw new Error(
    "No container runtime found. Install Docker, Podman, or Apple container.",
  );
}

/**
 * Select the container runtime and create its service.
 *
 * Uses `configRuntime` directly when it is valid. Otherwise selects the first
 * running runtime in `RUNTIMES` order, then the first installed runtime.
 */
export async function resolveRuntime(
  configRuntime: string | undefined,
  exec: RuntimeExecutor,
  options: ContainerRuntimeOptions,
): Promise<SandboxRuntimeSelection> {
  const logger = getLogger();
  logger.startTiming("Resolve runtime");

  if (configRuntime && RUNTIMES.includes(configRuntime as Runtime)) {
    logger.debug(`Using configured runtime: ${configRuntime}`);
    logger.endTiming("Resolve runtime");
    return createRuntimeService(configRuntime as Runtime, exec, options);
  }

  logger.debug("Auto-detecting container runtime...");
  try {
    return await detectRuntime(exec, options);
  } finally {
    logger.endTiming("Resolve runtime");
  }
}

/** Create the runtime and compatible image builder for a selected runtime. */
function createRuntimeService(
  runtime: Runtime,
  exec: RuntimeExecutor,
  options: ContainerRuntimeOptions,
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
