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
import type { ContainerRuntime } from "./types.js";

/** @lintignore Public runtime-provider contract. */
export interface ContainerRuntimeProvider {
  resolve(configuredRuntime?: string): Promise<ContainerRuntime>;
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
    async resolve(configuredRuntime) {
      const runtime = await resolveRuntime(configuredRuntime, exec);
      return createRuntimeService(runtime, exec);
    },
  };
}
