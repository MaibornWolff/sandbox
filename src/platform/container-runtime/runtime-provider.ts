import {
  createDependency,
  type DependencyBinding,
} from "#platform/dependency-injection/index.js";
import {
  executeProcessCommand,
  type ProcessManager,
} from "#platform/process/index.js";
import type { RuntimeExecutor } from "./executor.js";
import { probeRuntimes, resolveRuntime } from "./runtime.js";
import {
  type ContainerRuntimeOptions,
  DEFAULT_CONTAINER_RUNTIME_OPTIONS,
} from "./runtime-options.js";
import type { RuntimeProbe } from "./runtime-types.js";
import type { SandboxRuntimeSelection } from "./sandbox-contract.js";

export interface RuntimeResolutionRequest {
  readonly configuredRuntime?: string;
  readonly options: ContainerRuntimeOptions;
}

/** Internal dependency container shape. */
export interface ContainerRuntimeProvider {
  resolve(request?: RuntimeResolutionRequest): Promise<SandboxRuntimeSelection>;
  /** Report the status of each runtime that the host supports. */
  probe(): Promise<readonly RuntimeProbe[]>;
}

const runtimeProviderDependency = createDependency<ContainerRuntimeProvider>(
  "container runtime provider",
);

export function provideRuntimeProvider(
  provider: ContainerRuntimeProvider,
): DependencyBinding {
  return runtimeProviderDependency.provide(provider);
}

export function getRuntimeProvider(): ContainerRuntimeProvider {
  return runtimeProviderDependency.get();
}

export function createProductionRuntimeProvider(
  processes: ProcessManager,
): ContainerRuntimeProvider {
  const exec: RuntimeExecutor = (command, args, execOptions) =>
    executeProcessCommand(processes, command, args, execOptions);

  return {
    resolve(request) {
      return resolveRuntime(
        request?.configuredRuntime,
        exec,
        request?.options ?? DEFAULT_CONTAINER_RUNTIME_OPTIONS,
      );
    },
    probe() {
      return probeRuntimes(exec);
    },
  };
}
