import type { RuntimeExecutor } from "./executor.js";
import type { ContainerRuntimeOptions } from "./runtime-options.js";
import type { Runtime } from "./runtime-types.js";
import type {
  SandboxImageBuilder,
  SandboxRuntime,
} from "./sandbox-contract.js";

/** Static facts and the factory for one container runtime. */
export interface RuntimeDefinition {
  readonly runtime: Runtime;
  /** Executable that the runtime CLI uses. */
  readonly binaryName: string;
  /** Whether the runtime can run on the current host platform. */
  isSupportedOnHost(): boolean;
  create(
    exec: RuntimeExecutor,
    options: ContainerRuntimeOptions,
  ): SandboxRuntime & SandboxImageBuilder;
}
