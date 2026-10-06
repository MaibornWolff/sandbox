import { once } from "node:events";
import {
  chunkHostBridgePayload,
  HOST_BRIDGE_ENDPOINT_VARIABLE,
  openHostBridgeConnection,
} from "#modules/host-bridge/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { getProcessManager } from "#platform/process/index.js";
import { getTerminal } from "#platform/terminal/index.js";
import type {
  WebSocketConnection,
  WebSocketMessage,
} from "#platform/websocket/index.js";
import {
  decodeBinaryChannel,
  encodeBinaryChannel,
  encodeControlMessage,
  parseBrokerControlMessage,
  STREAM_CHANNEL,
} from "./protocol.js";

export type RunHostCommandEscapeOptions =
  | { readonly operation: "list" }
  | { readonly operation: "execute"; readonly argv: readonly string[] };

class HostCommandEscapeExitError extends Error {
  readonly reported = true;

  constructor(readonly exitCode: number) {
    super(`Host command escape exited with code ${exitCode}`);
  }
}

async function writeOutput(
  stream: NodeJS.WritableStream,
  chunk: Uint8Array | string,
): Promise<void> {
  if (stream.write(chunk)) return;
  await once(stream, "drain");
}

interface StdinForwarder {
  readonly completion: Promise<void>;
  stop(): void;
}

function readInputChunk(
  input: NodeJS.ReadableStream,
  signal: AbortSignal,
): Promise<Uint8Array | string | undefined> {
  if (signal.aborted || !input.readable) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.pause();
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onData = (chunk: Uint8Array | string) => {
      cleanup();
      resolve(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(undefined);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      resolve(undefined);
    };
    input.once("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    input.resume();
  });
}

function forwardStdin(connection: WebSocketConnection): StdinForwarder {
  const input = getTerminal().input;
  const controller = new AbortController();
  const forwarding = (async () => {
    for (;;) {
      const chunk = await readInputChunk(input, controller.signal);
      if (chunk === undefined) break;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      for (const frame of chunkHostBridgePayload(bytes, 1)) {
        await connection.sendBinary(
          encodeBinaryChannel(STREAM_CHANNEL.stdin, frame),
          { signal: controller.signal },
        );
      }
    }
    if (!controller.signal.aborted) {
      await connection.sendText(encodeControlMessage({ type: "stdin-end" }), {
        signal: controller.signal,
      });
    }
  })().catch(async () => {
    if (!controller.signal.aborted) {
      await connection.close(1011, "stdin-forwarding-failed");
    }
  });
  return {
    completion: forwarding,
    stop: () => controller.abort(),
  };
}

async function runList(connection: WebSocketConnection): Promise<void> {
  await connection.sendText(encodeControlMessage({ type: "list" }));
  for await (const incoming of connection.messages) {
    if (incoming.type !== "text") {
      throw new Error(
        "Host command escape list returned an invalid binary message.",
      );
    }
    const message = parseBrokerControlMessage(incoming.data);
    if (message.type === "allowed-commands") {
      if (message.patterns.length > 0) {
        await writeOutput(
          getTerminal().stdout,
          `${message.patterns.join("\n")}\n`,
        );
      }
      return;
    }
    if (message.type === "error") throw new Error(message.message);
    throw new Error("Host command escape list returned an unexpected message.");
  }
  throw new Error(
    "Host command escape broker closed before returning the allowlist.",
  );
}

interface ExecuteClientState {
  stdin?: StdinForwarder;
}

async function handleExecuteMessage(
  connection: WebSocketConnection,
  incoming: WebSocketMessage,
  state: ExecuteClientState,
): Promise<number | undefined> {
  if (incoming.type === "binary") {
    const decoded = decodeBinaryChannel(incoming.data);
    if (decoded.channel === STREAM_CHANNEL.stdout) {
      await writeOutput(getTerminal().stdout, decoded.payload);
      return undefined;
    }
    if (decoded.channel === STREAM_CHANNEL.stderr) {
      await writeOutput(getTerminal().stderr, decoded.payload);
      return undefined;
    }
    throw new Error("Host command escape broker used the stdin channel.");
  }
  const message = parseBrokerControlMessage(incoming.data);
  if (message.type === "ready") {
    if (state.stdin !== undefined) {
      throw new Error("Host command escape broker sent ready twice.");
    }
    state.stdin = forwardStdin(connection);
    return undefined;
  }
  if (message.type === "exit") return message.exitCode;
  if (message.type === "error") throw new Error(message.message);
  throw new Error(
    "Host command escape execute returned an unexpected message.",
  );
}

async function runExecute(
  connection: WebSocketConnection,
  argv: readonly string[],
): Promise<void> {
  const environment = getHostEnvironment();
  await connection.sendText(
    encodeControlMessage({
      type: "execute",
      argv,
      cwd: environment.currentWorkingDirectory,
    }),
  );
  const state: ExecuteClientState = {};
  let exited = false;
  const forwardSignal = (signal: "SIGINT" | "SIGTERM" | "SIGHUP") => {
    if (exited) return;
    void connection
      .sendText(encodeControlMessage({ type: "signal", signal }))
      .catch(() => undefined);
  };
  const abort = () => forwardSignal("SIGTERM");
  const terminal = getTerminal();
  terminal.signal.addEventListener("abort", abort, { once: true });
  void getProcessManager().termination.then((signal) => {
    if (signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGHUP") {
      forwardSignal(signal);
    }
  });
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(async () => {
    state.stdin?.stop();
    await state.stdin?.completion;
    terminal.signal.removeEventListener("abort", abort);
  });
  for await (const incoming of connection.messages) {
    const exitCode = await handleExecuteMessage(connection, incoming, state);
    if (exitCode === undefined) continue;
    exited = true;
    if (exitCode !== 0) throw new HostCommandEscapeExitError(exitCode);
    return;
  }
  throw new Error(
    "Host command escape broker closed before the command exited.",
  );
}

export async function runHostCommandEscape(
  options: RunHostCommandEscapeOptions,
): Promise<void> {
  const variables = getHostEnvironment().variables;
  if (!variables[HOST_BRIDGE_ENDPOINT_VARIABLE]) {
    await writeOutput(
      getTerminal().stderr,
      "sandbox escape: no active host command escape broker\n",
    );
    throw new HostCommandEscapeExitError(1);
  }
  try {
    const signal = getTerminal().signal;
    signal.throwIfAborted();
    await using connection = await openHostBridgeConnection({
      capability: "host-command",
      environment: variables,
      signal,
    });
    if (options.operation === "list") await runList(connection);
    else await runExecute(connection, options.argv);
  } catch (error) {
    if (error instanceof HostCommandEscapeExitError) throw error;
    const message = error instanceof Error ? error.message : "unknown error";
    await writeOutput(getTerminal().stderr, `sandbox escape: ${message}\n`);
    throw new HostCommandEscapeExitError(1);
  }
}
