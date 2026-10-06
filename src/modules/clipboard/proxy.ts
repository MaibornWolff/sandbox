import {
  createDependency,
  type DependencyBinding,
} from "#platform/dependency-injection/index.js";
import { getLogger } from "#platform/logging/index.js";
import type { X11ClipboardService } from "#platform/x11-clipboard/index.js";
import { createClipboardBridgeClient } from "./bridge-client.js";
import { reportStartupFailure, transferFailureCode } from "./proxy-protocol.js";

export {
  ClipboardProxyStartupError,
  decodeClipboardProxyNotice,
  decodeClipboardProxyReady,
} from "./proxy-protocol.js";

export interface ClipboardProxyRunner {
  run(options: {
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly signal: AbortSignal;
    readonly onControl: (line: string) => void;
  }): Promise<void>;
}

export function createClipboardProxyRunner(
  x11: X11ClipboardService,
): ClipboardProxyRunner {
  return {
    async run(options) {
      const bridge = createClipboardBridgeClient(options.environment);
      const logger = getLogger();
      logger.debug("Preparing private clipboard bridge");
      await bridge
        .ready(options.signal)
        .catch((error: unknown) =>
          reportStartupFailure("bridge", error, options.onControl),
        );
      await using display = await x11
        .openSession({
          discover: (signal) => bridge.discover(signal),
          read: (format, signal) => bridge.read(format, signal),
          publish: (item, signal) => bridge.publish(item, signal),
          onError: (error) => {
            options.onControl(
              `${JSON.stringify({ type: "clipboard-operation-failed", code: transferFailureCode(error) })}\n`,
            );
            logger.warn(
              "Clipboard transfer failed. The local copy was not confirmed on the host.",
            );
          },
          signal: options.signal,
        })
        .catch((error: unknown) =>
          reportStartupFailure("display", error, options.onControl),
        );
      options.signal.throwIfAborted();
      const ready = JSON.stringify({
        type: "clipboard-ready",
        display: display.environment.DISPLAY,
        authority: display.environment.XAUTHORITY,
      });
      options.onControl(`${ready}\n`);
      logger.debug("Private clipboard display is ready");
      await display.completion;
    },
  };
}

const dependency = createDependency<ClipboardProxyRunner>(
  "clipboard proxy runner",
);
export function provideClipboardProxyRunner(
  runner: ClipboardProxyRunner,
): DependencyBinding {
  return dependency.provide(runner);
}
export function getClipboardProxyRunner(): ClipboardProxyRunner {
  return dependency.get();
}
