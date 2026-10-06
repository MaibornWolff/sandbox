import type * as http from "node:http";
import type { Duplex } from "node:stream";
// `node-ws` aliases the npm `ws` package: under Bun the bare `ws` import resolves to a built-in shim that ignores the `ca` and `servername` pinning options.
import WebSocket, {
  WebSocketServer as NodeWebSocketServer,
  type RawData,
} from "node-ws";
import { createListener } from "./tls.js";
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

const DEFAULT_MAX_CONNECTIONS = 64;
const SOCKET_TIMEOUT_MS = 5000;
const MAX_PENDING_SENDS = 64;
const QUEUE_LIMIT_MESSAGES = 4;
const MIN_MESSAGE_WEIGHT = 256;
// The ws option exists at runtime but is missing from the type definitions.
const closeTimeoutOption = { closeTimeout: SOCKET_TIMEOUT_MS };

function pinnedTlsOptions(certificate: string) {
  return { ca: certificate, servername: "localhost", rejectUnauthorized: true };
}

function byteSize(data: string | Uint8Array): number {
  return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #ended = false;

  push(value: T): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else if (this.enqueue(value)) this.#values.push(value);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  /** Returns false when the value must be dropped. */
  protected enqueue(_value: T): boolean {
    return true;
  }

  protected dequeued(_value: T, _remaining: number): void {}

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) {
          this.dequeued(value, this.#values.length);
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

/** Pauses the socket while messages wait and terminates it on overflow. */
class MessageQueue extends AsyncQueue<WebSocketMessage> {
  readonly #limit: number;
  #size = 0;

  constructor(
    private readonly socket: WebSocket,
    maxMessageBytes: number,
  ) {
    super();
    this.#limit = maxMessageBytes * QUEUE_LIMIT_MESSAGES;
  }

  static weight(message: WebSocketMessage): number {
    return Math.max(MIN_MESSAGE_WEIGHT, byteSize(message.data));
  }

  protected override enqueue(message: WebSocketMessage): boolean {
    const weight = MessageQueue.weight(message);
    if (this.#size + weight > this.#limit) {
      this.socket.terminate();
      return false;
    }
    this.#size += weight;
    this.socket.pause();
    return true;
  }

  protected override dequeued(
    message: WebSocketMessage,
    remaining: number,
  ): void {
    this.#size -= MessageQueue.weight(message);
    if (remaining === 0) this.socket.resume();
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
    const onAbort = () => {
      socket.terminate();
      finish(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.send(data, { binary, compress: false }, (error) => finish(error));
  });
}

function wrapConnection(
  socket: WebSocket,
  maxMessageBytes: number,
  path?: string,
): WebSocketConnection {
  const messages = new MessageQueue(socket, maxMessageBytes);
  let resolveClosed: (details: WebSocketCloseDetails) => void = () => {};
  const closed = new Promise<WebSocketCloseDetails>((resolve) => {
    resolveClosed = resolve;
  });
  socket.on("message", (data, isBinary) => {
    const message = decodeMessage(data, isBinary);
    if (byteSize(message.data) > maxMessageBytes) {
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

  let pendingBytes = 0;
  let pendingMessages = 0;
  const send = async (
    data: string | Uint8Array,
    binary: boolean,
    signal?: AbortSignal,
  ) => {
    const size = byteSize(data);
    if (size > maxMessageBytes)
      throw new Error("WebSocket message exceeds maximum size.");
    if (
      pendingBytes + size > maxMessageBytes * QUEUE_LIMIT_MESSAGES ||
      pendingMessages >= MAX_PENDING_SENDS
    )
      throw new Error("WebSocket send queue is full.");
    pendingBytes += size;
    pendingMessages += 1;
    using _reservation = {
      [Symbol.dispose]: () => {
        pendingBytes -= size;
        pendingMessages -= 1;
      },
    };
    await waitForSend(socket, data, binary, signal);
  };
  const connection: WebSocketConnection = {
    protocol: socket.protocol,
    ...(path === undefined ? {} : { path }),
    messages,
    closed,
    sendText(message, options) {
      return send(message, false, options?.signal);
    },
    sendBinary(message, options) {
      return send(message, true, options?.signal);
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
  using cleanup = new DisposableStack();
  const closed = new Promise<WebSocketUpgradeDecision>((resolve) => {
    const onClose = () =>
      resolve({
        accepted: false,
        statusCode: 408,
        reason: "Upgrade interrupted",
      });
    options.socket.once("close", onClose);
    cleanup.defer(() => options.socket.removeListener("close", onClose));
  });
  const decision = await Promise.race([
    closed,
    options.configuration.authorizeUpgrade({
      path: options.request.url ?? "/",
      headers: options.request.headers,
    }),
  ]);
  if (options.socket.destroyed) return;
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
  const { server: httpServer, certificate } = await createListener();
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  httpServer.headersTimeout = SOCKET_TIMEOUT_MS;
  httpServer.requestTimeout = SOCKET_TIMEOUT_MS;
  httpServer.maxConnections = maxConnections;
  const sockets = new Set<Duplex>();
  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
  });
  const nodeServer = new NodeWebSocketServer({
    noServer: true,
    ...closeTimeoutOption,
    maxPayload: options.maxMessageBytes + 1,
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      protocols.has(options.protocol) ? options.protocol : false,
  });
  const connections = new AsyncQueue<WebSocketConnection>();
  const activeConnections = new Set<WebSocketConnection>();
  let disposed = false;

  let pendingUpgrades = 0;
  httpServer.on("upgrade", (request, socket, head) => {
    if (
      disposed ||
      pendingUpgrades + activeConnections.size >= maxConnections
    ) {
      rejectUpgrade(socket, {
        accepted: false,
        statusCode: 503,
        reason: "Connection limit reached",
      });
      return;
    }
    pendingUpgrades += 1;
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
        request.socket.setTimeout(0);
        const connection = wrapConnection(
          webSocket,
          options.maxMessageBytes,
          request.url,
        );
        activeConnections.add(connection);
        void connection.closed.then(() => activeConnections.delete(connection));
        connections.push(connection);
      },
    })
      .catch(() =>
        rejectUpgrade(socket, {
          accepted: false,
          statusCode: 500,
          reason: "WebSocket upgrade authorization failed",
        }),
      )
      .finally(() => {
        pendingUpgrades -= 1;
      });
  });
  await listen(httpServer, options.host, options.port);
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    httpServer.close();
    throw new Error("WebSocket server did not expose a TCP endpoint.");
  }

  const server: WebSocketServer = {
    endpoint: { host: options.host, port: address.port },
    certificate,
    connections,
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      disposed = true;
      connections.end();
      for (const socket of sockets) socket.destroy();
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
      handshakeTimeout: SOCKET_TIMEOUT_MS,
      ...closeTimeoutOption,
      ...pinnedTlsOptions(options.pinnedCertificate),
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
      const connection = wrapConnection(socket, options.maxMessageBytes);
      void connection.closed.then(() =>
        options.signal?.removeEventListener("abort", onAbort),
      );
      resolve(connection);
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
