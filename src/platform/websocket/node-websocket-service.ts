import * as http from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, {
  WebSocketServer as NodeWebSocketServer,
  type RawData,
} from "ws";
import type {
  ConnectWebSocketOptions,
  StartWebSocketServerOptions,
  WebSocketCloseDetails,
  WebSocketConnection,
  WebSocketMessage,
  WebSocketServer,
  WebSocketService,
  WebSocketUpgradeDecision,
} from "./websocket-service.js";

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #ended = false;

  constructor(
    private readonly pause: () => void,
    private readonly resume: () => void,
  ) {}

  push(value: T): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else {
      this.#values.push(value);
      this.pause();
    }
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) {
          if (this.#values.length === 0) this.resume();
          return Promise.resolve({ done: false, value });
        }
        if (this.#ended) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function abortError(): Error {
  const error = new Error("The WebSocket operation was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function decodeMessage(data: RawData, isBinary: boolean): WebSocketMessage {
  const bytes = new Uint8Array(
    data instanceof ArrayBuffer
      ? data
      : Buffer.isBuffer(data)
        ? data
        : Buffer.concat(data),
  );
  return isBinary
    ? { type: "binary", data: bytes }
    : { type: "text", data: Buffer.from(bytes).toString("utf8") };
}

async function waitForSend(
  socket: WebSocket,
  data: string | Uint8Array,
  binary: boolean,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  if (socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("WebSocket connection is not open."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.send(data, { binary, compress: false }, (error) => finish(error));
  });
}

function wrapConnection(
  socket: WebSocket,
  maxMessageBytes: number,
): WebSocketConnection {
  const messages = new AsyncQueue<WebSocketMessage>(
    () => {
      if (typeof socket.pause === "function") socket.pause();
    },
    () => {
      if (typeof socket.resume === "function") socket.resume();
    },
  );
  let resolveClosed: (details: WebSocketCloseDetails) => void = () => {};
  const closed = new Promise<WebSocketCloseDetails>((resolve) => {
    resolveClosed = resolve;
  });
  socket.on("message", (data, isBinary) => {
    const message = decodeMessage(data, isBinary);
    const size =
      message.type === "text"
        ? Buffer.byteLength(message.data)
        : message.data.byteLength;
    if (size > maxMessageBytes) {
      socket.close(1009, "Message exceeds maximum size");
      return;
    }
    messages.push(message);
  });
  socket.once("close", (code, reason) => {
    messages.end();
    resolveClosed({
      code,
      reason: reason.toString("utf8"),
      wasClean: code !== 1006,
    });
  });
  socket.on("error", () => {});

  const connection: WebSocketConnection = {
    protocol: socket.protocol,
    messages,
    closed,
    sendText(message, options) {
      return waitForSend(socket, message, false, options?.signal);
    },
    sendBinary(message, options) {
      return waitForSend(socket, message, true, options?.signal);
    },
    async close(code = 1000, reason = "") {
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      return closed;
    },
    async [Symbol.asyncDispose]() {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      await closed;
    },
  };
  return connection;
}

function hasRequiredProtocol(
  header: string | undefined,
  protocol: string,
): boolean {
  return (header ?? "").split(",").some((item) => item.trim() === protocol);
}

function rejectUpgrade(
  socket: Duplex,
  decision: Exclude<WebSocketUpgradeDecision, { readonly accepted: true }>,
): void {
  const statusCode =
    decision.statusCode &&
    decision.statusCode >= 400 &&
    decision.statusCode <= 599
      ? decision.statusCode
      : 401;
  const reason = (decision.reason ?? "WebSocket upgrade rejected").replace(
    /[\r\n]/gu,
    " ",
  );
  socket.end(
    `HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

async function authorizeAndUpgrade(options: {
  readonly request: http.IncomingMessage;
  readonly socket: Duplex;
  readonly head: Buffer;
  readonly server: NodeWebSocketServer;
  readonly configuration: StartWebSocketServerOptions;
  readonly accept: (socket: WebSocket) => void;
}): Promise<void> {
  if (
    !hasRequiredProtocol(
      options.request.headers["sec-websocket-protocol"],
      options.configuration.protocol,
    )
  ) {
    rejectUpgrade(options.socket, {
      accepted: false,
      statusCode: 426,
      reason: "Required WebSocket subprotocol is missing",
    });
    return;
  }
  const decision = await options.configuration.authorizeUpgrade({
    path: options.request.url ?? "/",
    headers: options.request.headers,
    ...(options.request.socket.remoteAddress
      ? { remoteAddress: options.request.socket.remoteAddress }
      : {}),
  });
  if (!decision.accepted) {
    rejectUpgrade(options.socket, decision);
    return;
  }
  options.server.handleUpgrade(
    options.request,
    options.socket,
    options.head,
    options.accept,
  );
}

async function listen(
  server: http.Server,
  host: string,
  port: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function startServer(
  options: StartWebSocketServerOptions,
): Promise<WebSocketServer> {
  throwIfAborted(options.signal);
  const httpServer = http.createServer((_request, response) => {
    response.writeHead(426).end();
  });
  const nodeServer = new NodeWebSocketServer({
    noServer: true,
    maxPayload: Math.min(options.maxMessageBytes + 1, Number.MAX_SAFE_INTEGER),
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      protocols.has(options.protocol) ? options.protocol : false,
  });
  const connections = new AsyncQueue<WebSocketConnection>(
    () => undefined,
    () => undefined,
  );
  const activeConnections = new Set<WebSocketConnection>();
  let disposed = false;
  let startupAborted = false;
  const onStartupAbort = () => {
    startupAborted = true;
  };
  options.signal?.addEventListener("abort", onStartupAbort, { once: true });

  httpServer.on("upgrade", (request, socket, head) => {
    void authorizeAndUpgrade({
      request,
      socket,
      head,
      server: nodeServer,
      configuration: options,
      accept: (webSocket) => {
        if (disposed) {
          webSocket.terminate();
          return;
        }
        const connection = wrapConnection(webSocket, options.maxMessageBytes);
        activeConnections.add(connection);
        void connection.closed.then(() => activeConnections.delete(connection));
        connections.push(connection);
      },
    }).catch(() =>
      rejectUpgrade(socket, {
        accepted: false,
        statusCode: 500,
        reason: "WebSocket upgrade authorization failed",
      }),
    );
  });
  try {
    await listen(httpServer, options.host, options.port);
  } catch (error) {
    nodeServer.close();
    if (startupAborted) throw abortError();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onStartupAbort);
  }
  if (startupAborted) {
    nodeServer.close();
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
    throw abortError();
  }
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    httpServer.close();
    throw new Error("WebSocket server did not expose a TCP endpoint.");
  }

  const server: WebSocketServer = {
    endpoint: { host: options.host, port: address.port },
    connections,
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      disposed = true;
      options.signal?.removeEventListener("abort", onAbort);
      connections.end();
      await Promise.all(
        [...activeConnections].map((connection) =>
          connection[Symbol.asyncDispose](),
        ),
      );
      await new Promise<void>((resolve, reject) =>
        nodeServer.close((error) => (error ? reject(error) : resolve())),
      );
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  const onAbort = () => void server[Symbol.asyncDispose]();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  return server;
}

async function connect(
  options: ConnectWebSocketOptions,
): Promise<WebSocketConnection> {
  throwIfAborted(options.signal);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(options.url, options.protocol, {
      headers: options.headers,
      maxPayload: options.maxMessageBytes,
      perMessageDeflate: false,
    });
    let settled = false;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = () => {
      socket.terminate();
      finishError(abortError());
    };
    socket.once("open", () => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      resolve(wrapConnection(socket, options.maxMessageBytes));
    });
    socket.on("error", (error: unknown) =>
      finishError(
        error instanceof Error
          ? error
          : new Error(
              "WebSocket connection failed during the opening handshake.",
            ),
      ),
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createNodeWebSocketService(): WebSocketService {
  return { startServer, connect };
}
