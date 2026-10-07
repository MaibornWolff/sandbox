import { StringDecoder } from "node:string_decoder";
import type { SandboxRuntime } from "#platform/container-runtime/index.js";
import { getLogger } from "#platform/logging/index.js";

const MAX_LINES = 200;
const MAX_LINE_LENGTH = 16_384;

export interface StartupLogCapture extends AsyncDisposable {
  reportFailure(): void;
  stop(): Promise<void>;
}

export function captureStartupLogs(
  runtime: SandboxRuntime,
  containerName: string,
): StartupLogCapture {
  const lines: string[] = [];
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let truncated = false;
  const finishLine = (debug: boolean): void => {
    const line =
      pending.replace(/\r$/u, "") + (truncated ? " [truncated]" : "");
    lines.push(line);
    if (lines.length > MAX_LINES) lines.shift();
    if (debug) getLogger().debug(line);
    pending = "";
    truncated = false;
  };
  const appendSegment = (segment: string): void => {
    const remaining = MAX_LINE_LENGTH - pending.length;
    pending += segment.slice(0, remaining);
    if (segment.length > remaining) truncated = true;
  };
  const append = (text: string): void => {
    let start = 0;
    let newline = text.indexOf("\n");
    while (newline !== -1) {
      appendSegment(text.slice(start, newline));
      finishLine(true);
      start = newline + 1;
      newline = text.indexOf("\n", start);
    }
    appendSegment(text.slice(start));
  };
  const capture = (chunk: Buffer): void => append(decoder.write(chunk));
  const subscription = runtime.instances.followLogs(containerName, {
    tail: MAX_LINES,
    onOutput: capture,
    onError: capture,
  });
  const flush = (): void => {
    append(decoder.end());
    if (pending || truncated) finishLine(false);
  };
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped ??= subscription.stop().then(flush, (error: unknown) => {
      getLogger().warn(
        `Could not stop startup log capture for ${containerName}: ${error instanceof Error ? error.message : String(error)}`,
      );
      flush();
    });
    return stopped;
  };
  return {
    reportFailure() {
      getLogger().error(
        lines.length > 0
          ? `Container startup logs for ${containerName}:\n${lines.join("\n")}`
          : `Container startup for ${containerName} produced no captured logs`,
      );
    },
    stop,
    async [Symbol.asyncDispose]() {
      await stop();
    },
  };
}
