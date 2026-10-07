import {
  createDependency,
  type DependencyBinding,
} from "#platform/dependency-injection/index.js";
import {
  executeProcessCommand,
  type ProcessManager,
} from "#platform/process/index.js";
import type { RuntimeExecutor } from "./executor.js";
import { createRuntimeService, resolveRuntime } from "./runtime.js";
import {
  type ContainerRuntimeOptions,
  DEFAULT_CONTAINER_RUNTIME_OPTIONS,
} from "./runtime-options.js";
import type { SandboxRuntimeSelection } from "./sandbox-contract.js";

export interface RuntimeResolutionRequest {
  readonly configuredRuntime?: string;
  readonly options: ContainerRuntimeOptions;
}

/** Internal dependency container shape. */
export interface ContainerRuntimeProvider {
  resolve(request?: RuntimeResolutionRequest): Promise<SandboxRuntimeSelection>;
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
    async resolve(request) {
      const runtime = await resolveRuntime(request?.configuredRuntime, exec);
      return createRuntimeService(
        runtime,
        exec,
        request?.options ?? DEFAULT_CONTAINER_RUNTIME_OPTIONS,
      );
    },
  };
}
