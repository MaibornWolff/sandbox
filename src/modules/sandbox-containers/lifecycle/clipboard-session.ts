import chalk from "chalk";
import {
  ClipboardProxyStartupError,
  decodeClipboardProxyNotice,
  decodeClipboardProxyReady,
} from "#modules/clipboard/index.js";
import { getClock, waitWithTimeout } from "#platform/clock/index.js";
import type { SandboxInstanceOperations } from "#platform/container-runtime/index.js";
import { getLogger } from "#platform/logging/index.js";

interface ClipboardSession extends AsyncDisposable {
  readonly environment: Readonly<Record<string, string>>;
}

interface ClipboardSessionOptions {
  readonly containers: SandboxInstanceOperations;
  readonly containerId: string;
  readonly bridgeEnvironment: Readonly<Record<string, string>>;
}

type ClipboardEnvironment = Readonly<Record<string, string>>;

async function consumeReadiness(
  stream: AsyncIterable<Uint8Array>,
  ready: PromiseWithResolvers<ClipboardEnvironment>,
): Promise<void> {
  let pending = Buffer.alloc(0);
  let reported = false;
  for await (const bytes of stream) {
    if (pending.length + bytes.length > 4096)
      throw new Error("Clipboard readiness exceeded its limit.");
    pending = Buffer.concat([pending, bytes]);
    let newline = pending.indexOf(10);
    while (newline >= 0) {
      const line = pending.subarray(0, newline).toString("utf8");
      if (reported) getLogger().warn(decodeClipboardProxyNotice(line));
      else {
        ready.resolve({ ...decodeClipboardProxyReady(line) });
        reported = true;
      }
      pending = pending.subarray(newline + 1);
      newline = pending.indexOf(10);
    }
  }
  if (!reported)
    ready.reject(new Error("Clipboard proxy stopped before readiness."));
}

async function drainDiagnostics(
  stream: AsyncIterable<Uint8Array>,
): Promise<void> {
  let count = 0;
  for await (const bytes of stream) count += bytes.length;
  if (count)
    getLogger().debug(
      `Clipboard proxy diagnostics: ${count} bytes (content withheld)`,
    );
}

async function startSession(
  options: ClipboardSessionOptions,
): Promise<ClipboardSession> {
  await using resources = new AsyncDisposableStack();
  const proxy = await options.containers.openExec(options.containerId, {
    command: ["/usr/local/bin/sandbox-container-tools", "clipboard-proxy"],
    user: "sandbox",
    environment: options.bridgeEnvironment,
  });
  const ready = Promise.withResolvers<ClipboardEnvironment>();
  const output = consumeReadiness(proxy.stdout, ready).catch((error: unknown) =>
    ready.reject(
      error instanceof ClipboardProxyStartupError
        ? error
        : new Error("Clipboard proxy readiness failed."),
    ),
  );
  const diagnostics = drainDiagnostics(proxy.stderr).catch(() =>
    getLogger().warn("Clipboard proxy diagnostic stream failed."),
  );
  resources.defer(async () => {
    await Promise.all([output, diagnostics]);
  });
  // Disposal runs in reverse order: stop the proxy first, then wait for its streams.
  resources.use(proxy);
  const preparation = Promise.race([
    ready.promise,
    proxy.completion.then(async () => {
      await output;
      throw new Error("Clipboard proxy stopped during startup.");
    }),
  ]);
  const startup = await waitWithTimeout(preparation, {
    clock: getClock(),
    milliseconds: 10_000,
  });
  if (!startup.completed) throw new Error("Clipboard proxy startup timed out.");
  const lifetime = resources.move();
  let disposing = false;
  const reportExit = (outcome: string) => () => {
    if (!disposing)
      getLogger().warn(
        `Private clipboard proxy ${outcome} during the attached session.`,
      );
  };
  const monitor = proxy.completion.then(
    reportExit("stopped"),
    reportExit("failed"),
  );
  return {
    environment: startup.value,
    async [Symbol.asyncDispose]() {
      disposing = true;
      await lifetime.disposeAsync();
      await monitor;
    },
  };
}

export async function prepareClipboardSession(
  options: ClipboardSessionOptions,
): Promise<ClipboardSession> {
  const logger = getLogger();
  logger.debug(
    `Starting private clipboard session for ${chalk.cyan(options.containerId)}`,
  );
  return startSession(options).catch((error: unknown) => {
    const detail =
      error instanceof ClipboardProxyStartupError
        ? `${error.phase}: ${error.code}`
        : "private proxy startup failed";
    logger.warn(
      `Clipboard is unavailable: ${detail}. The command and terminal text paste remain available.`,
    );
    return { environment: {}, async [Symbol.asyncDispose]() {} };
  });
}
