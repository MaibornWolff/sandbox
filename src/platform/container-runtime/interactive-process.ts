import {
  getProcessManager,
  type ProcessResult,
} from "#platform/process/index.js";
import { getTerminal } from "#platform/terminal/index.js";
import type { ContainerRuntime } from "./types.js";

interface InteractiveContainerRuntimeProcessOptions {
  readonly args: readonly string[];
  readonly title?: string;
  readonly signalContainer?: string;
  readonly forwardSignal?: (signal: NodeJS.Signals) => Promise<boolean>;
}

function createContainerSignalForwarder(
  runtime: Partial<Pick<ContainerRuntime, "signalContainer">>,
  containerName: string | undefined,
): ((signal: NodeJS.Signals) => Promise<boolean>) | undefined {
  const signalContainer = runtime.signalContainer?.bind(runtime);
  if (!containerName || !signalContainer) return undefined;
  return async (signal) => {
    await signalContainer(containerName, signal);
    return true;
  };
}

/**
 * Run an interactive container-runtime command through the scoped process
 * boundary. Terminal input/output, cancellation, signal forwarding, and title
 * restoration follow the lifetime of the awaited child.
 */
export async function runInteractiveContainerRuntimeProcess(
  runtime: Pick<ContainerRuntime, "binaryName"> &
    Partial<Pick<ContainerRuntime, "signalContainer">>,
  options: InteractiveContainerRuntimeProcessOptions,
): Promise<ProcessResult> {
  const terminal = getTerminal();
  const forwardSignal =
    options.forwardSignal ??
    createContainerSignalForwarder(runtime, options.signalContainer);
  return getProcessManager().start({
    command: runtime.binaryName,
    args: options.args,
    lifetime: "application",
    interaction: {
      mode: "interactive",
      ...(options.title ? { title: options.title } : {}),
      ...(forwardSignal ? { forwardSignal } : {}),
    },
    stdio: "inherit",
    signal: terminal.signal,
    name: "container runtime interactive execution",
  }).result;
}
