import {
  getProcessManager,
  type ManagedProcess,
  type ProcessResult,
} from "#platform/process/index.js";
import { getTerminal } from "#platform/terminal/index.js";

interface InteractiveContainerRuntimeProcessOptions {
  readonly args: readonly string[];
  readonly title?: string;
  readonly signalContainer?: string;
  readonly forwardSignal?: (signal: NodeJS.Signals) => Promise<boolean>;
}

interface InteractiveRuntimeProcess {
  readonly binaryName: string;
  signalContainer?(id: string, signal: NodeJS.Signals): Promise<void>;
}

function createContainerSignalForwarder(
  runtime: InteractiveRuntimeProcess,
  containerName: string | undefined,
): ((signal: NodeJS.Signals) => Promise<boolean>) | undefined {
  const signalContainer = runtime.signalContainer?.bind(runtime);
  if (!containerName || !signalContainer) return undefined;
  return async (signal) => {
    await signalContainer(containerName, signal);
    return true;
  };
}

export function startInteractiveContainerRuntimeProcess(
  runtime: InteractiveRuntimeProcess,
  options: InteractiveContainerRuntimeProcessOptions,
): ManagedProcess<ProcessResult> {
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
  });
}

export async function runInteractiveContainerRuntimeProcess(
  runtime: InteractiveRuntimeProcess,
  options: InteractiveContainerRuntimeProcessOptions,
): Promise<ProcessResult> {
  return startInteractiveContainerRuntimeProcess(runtime, options).result;
}
