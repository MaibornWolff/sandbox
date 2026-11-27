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
  readonly attachmentStarted?: (pid: number) => void;
  readonly attachmentExited?: () => void;
}

interface InteractiveRuntimeProcess {
  readonly binaryName: string;
  readonly env?: Readonly<Record<string, string>>;
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
    ...(runtime.env ? { env: runtime.env } : {}),
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
  const child = startInteractiveContainerRuntimeProcess(runtime, options);
  if (options.attachmentExited)
    void child.exited.then(options.attachmentExited, options.attachmentExited);
  if (child.pid !== undefined) options.attachmentStarted?.(child.pid);
  return child.result;
}
