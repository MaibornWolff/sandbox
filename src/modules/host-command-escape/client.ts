import { once } from "node:events";
import { getHostEnvironment } from "#platform/environment/index.js";
import { getProcessManager } from "#platform/process/index.js";
import { getTerminal } from "#platform/terminal/index.js";
import {
  getWebSocketService,
  type WebSocketConnection,
  type WebSocketMessage,
} from "#platform/websocket/index.js";
import {
  decodeBinaryChannel,
  encodeBinaryChannel,
  encodeControlMessage,
  HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE,
  HOST_COMMAND_ESCAPE_MAX_MESSAGE_BYTES,
  HOST_COMMAND_ESCAPE_PROTOCOL_VARIABLE,
  HOST_COMMAND_ESCAPE_TOKEN_VARIABLE,
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
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onData = (chunk: Uint8Array | string) => {
      input.pause();
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
  const completion = (async () => {
    for (;;) {
      const chunk = await readInputChunk(input, controller.signal);
      if (chunk === undefined) break;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (bytes.byteLength > 0) {
        await connection.sendBinary(
          encodeBinaryChannel(STREAM_CHANNEL.stdin, bytes),
        );
      }
    }
    if (!controller.signal.aborted) {
      await connection.sendText(encodeControlMessage({ type: "stdin-end" }));
    }
  })();
  return { completion, stop: () => controller.abort() };
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
  getTerminal().signal.addEventListener("abort", abort, { once: true });
  void getProcessManager().termination.then((signal) => {
    if (signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGHUP") {
      forwardSignal(signal);
    }
  });
  try {
    for await (const incoming of connection.messages) {
      const exitCode = await handleExecuteMessage(connection, incoming, state);
      if (exitCode === undefined) continue;
      exited = true;
      state.stdin?.stop();
      await state.stdin?.completion.catch(() => undefined);
      if (exitCode !== 0) throw new HostCommandEscapeExitError(exitCode);
      return;
    }
    throw new Error(
      "Host command escape broker closed before the command exited.",
    );
  } finally {
    state.stdin?.stop();
    getTerminal().signal.removeEventListener("abort", abort);
  }
}

export async function runHostCommandEscape(
  options: RunHostCommandEscapeOptions,
): Promise<void> {
  const variables = getHostEnvironment().variables;
  const endpoint = variables[HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE];
  const protocol = variables[HOST_COMMAND_ESCAPE_PROTOCOL_VARIABLE];
  const token = variables[HOST_COMMAND_ESCAPE_TOKEN_VARIABLE];
  if (!endpoint || !protocol || !token) {
    await writeOutput(
      getTerminal().stderr,
      "sandbox escape: no active host command escape broker\n",
    );
    throw new HostCommandEscapeExitError(1);
  }
  let connection: WebSocketConnection | undefined;
  try {
    connection = await getWebSocketService().connect({
      url: endpoint,
      protocol,
      maxMessageBytes: HOST_COMMAND_ESCAPE_MAX_MESSAGE_BYTES,
      headers: { authorization: `Bearer ${token}` },
      signal: getTerminal().signal,
    });
    await using managedConnection = connection;
    if (options.operation === "list") await runList(managedConnection);
    else await runExecute(managedConnection, options.argv);
  } catch (error) {
    if (error instanceof HostCommandEscapeExitError) throw error;
    const message = error instanceof Error ? error.message : "unknown error";
    await writeOutput(getTerminal().stderr, `sandbox escape: ${message}\n`);
    throw new HostCommandEscapeExitError(1);
  }
}
