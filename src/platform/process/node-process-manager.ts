import type { Clock } from "#platform/clock/index.js";
import type { Logger } from "#platform/logging/index.js";
import { createNodeProcessAdapter } from "./node-process-adapter.js";
import { createProcessManager } from "./process-lifecycle.js";
import type { ProcessManager } from "./process-manager.js";

export function createNodeProcessManager(options: {
  readonly environment: {
    readonly currentWorkingDirectory: string;
    readonly variables: Readonly<Record<string, string>>;
    readonly platform?: NodeJS.Platform;
  };
  readonly terminal: {
    readonly input: NodeJS.ReadableStream;
    readonly stdout: NodeJS.WritableStream;
    readonly stderr: NodeJS.WritableStream;
    readonly signal?: AbortSignal;
    readonly interactive?: boolean;
  };
  readonly clock: Clock;
  readonly logger?: Pick<Logger, "debug" | "warn" | "error">;
}): ProcessManager {
  return createProcessManager({
    adapter: createNodeProcessAdapter(options),
    clock: options.clock,
    ...(options.logger ? { logger: options.logger } : {}),
  });
}
