import type { ProcessTerminalStreams } from "./terminal.js";

const guardedOutputs = new WeakSet<NodeJS.WritableStream>();

type WriteCallback = (error?: Error | null) => void;

function guardOutput(stream: NodeJS.WritableStream): void {
  if (guardedOutputs.has(stream)) return;
  guardedOutputs.add(stream);

  const isTerminal = "isTTY" in stream && stream.isTTY === true;
  let disconnected = false;
  function handleDisconnect(error: unknown): boolean {
    if (!(error instanceof Error) || !("code" in error)) return false;
    if (error.code !== "EPIPE" && !(isTerminal && error.code === "EIO")) {
      return false;
    }
    disconnected = true;
    return true;
  }

  stream.on("error", (error: Error) => {
    if (!handleDisconnect(error)) throw error;
  });

  const write = stream.write.bind(stream);
  stream.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean => {
    const onWrite =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    const discard = () => {
      if (onWrite) queueMicrotask(onWrite);
      return true;
    };
    if (disconnected) return discard();

    const complete: WriteCallback | undefined =
      onWrite &&
      ((error) => {
        onWrite(handleDisconnect(error) ? undefined : error);
      });
    try {
      if (
        typeof chunk === "string" &&
        typeof encodingOrCallback !== "function"
      ) {
        return write(chunk, encodingOrCallback, complete);
      }
      return write(chunk, complete);
    } catch (error) {
      if (!handleDisconnect(error)) throw error;
      return discard();
    }
  };
}

export function installTerminalOutputProtection(
  streams: ProcessTerminalStreams,
): void {
  // Keep the original handles for child stdio and the TUI. Error handlers must
  // outlive application cleanup because pending writes can fail after it returns.
  guardOutput(streams.stdout);
  guardOutput(streams.stderr);
}
