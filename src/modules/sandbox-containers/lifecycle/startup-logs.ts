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
  const capture = (chunk: Buffer): void => {
    const values = `${pending}${decoder.write(chunk)}`.split("\n");
    pending = values.pop() ?? "";
    for (const value of values) {
      const line = value.slice(0, MAX_LINE_LENGTH).replace(/\r$/u, "");
      lines.push(line);
      if (lines.length > MAX_LINES) lines.shift();
      getLogger().debug(line);
    }
  };
  const subscription = runtime.instances.followLogs(containerName, {
    tail: MAX_LINES,
    onOutput: capture,
    onError: capture,
  });
  const stop = async (): Promise<void> => {
    await subscription.stop();
    const final = `${pending}${decoder.end()}`;
    if (final) {
      lines.push(final.slice(0, MAX_LINE_LENGTH));
      if (lines.length > MAX_LINES) lines.shift();
    }
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
