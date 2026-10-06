import chalk from "chalk";
import type { Clock } from "#platform/clock/index.js";
import { getLogger } from "#platform/logging/index.js";
import type { ProcessManager } from "#platform/process/index.js";
import { openDisplay } from "./display.js";
import { deadline, X11Error } from "./operation.js";
import { ClipboardSelection, type X11ClipboardOptions } from "./selection.js";

function startupFailure(error: unknown): Error {
  const code = startupCode(error);
  return Object.assign(
    new Error(`Private clipboard startup failed: ${code}.`, { cause: error }),
    { code },
  );
}

function startupCode(error: unknown): string {
  if (error instanceof X11Error) return `display-${error.code}`;
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    return "display-executable-unavailable";
  return "display-unavailable";
}

export interface X11ClipboardSession extends AsyncDisposable {
  readonly environment: Readonly<Record<string, string>>;
  readonly completion: Promise<void>;
}

export interface X11ClipboardService {
  openSession(options: X11ClipboardOptions): Promise<X11ClipboardSession>;
}

export function createX11ClipboardService(edges: {
  processes: ProcessManager;
  clock: Clock;
}): X11ClipboardService {
  return {
    async openSession(options) {
      getLogger().debug(
        `Starting private clipboard display with ${chalk.cyan("Xvfb")}`,
      );
      const resources = new AsyncDisposableStack();
      const cancellation = new AbortController();
      const signal = options.signal
        ? AbortSignal.any([options.signal, cancellation.signal])
        : cancellation.signal;
      try {
        const display = resources.use(await openDisplay({ ...edges, signal }));
        resources.use(
          await deadline({
            clock: edges.clock,
            signal,
            milliseconds: 5_000,
            run: () =>
              Promise.race([
                ClipboardSelection.open(display.connection, edges.clock, {
                  ...options,
                  signal,
                }),
                display.completion.then(() => {
                  throw new Error("Private X11 display stopped during startup");
                }),
              ]),
          }),
        );
        getLogger().debug(
          `Private clipboard display ${chalk.cyan(display.environment.DISPLAY)} is ready`,
        );
        const owned = resources.move();
        const dispose = async () => {
          if (!cancellation.signal.aborted)
            getLogger().debug("Stopping private clipboard display");
          cancellation.abort();
          await owned.disposeAsync();
        };
        const completion = display.completion.then(
          dispose,
          async (error: unknown) => {
            options.onError(
              new Error("Private X11 display stopped unexpectedly"),
            );
            await dispose();
            throw error;
          },
        );
        return {
          environment: display.environment,
          completion,
          [Symbol.asyncDispose]: dispose,
        };
      } catch (error) {
        cancellation.abort();
        await resources.disposeAsync();
        throw startupFailure(error);
      }
    },
  };
}
