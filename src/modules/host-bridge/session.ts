import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import chalk from "chalk";
import {
  createDependency,
  type DependencyBinding,
} from "#platform/dependency-injection/index.js";
import { getLogger } from "#platform/logging/index.js";
import type {
  WebSocketConnection,
  WebSocketServer,
  WebSocketService,
  WebSocketUpgradeDecision,
} from "#platform/websocket/index.js";
import {
  HOST_BRIDGE_CERTIFICATE_VARIABLE,
  HOST_BRIDGE_ENDPOINT_VARIABLE,
  HOST_BRIDGE_MAX_CONNECTIONS,
  HOST_BRIDGE_MAX_MESSAGE_BYTES,
  HOST_BRIDGE_PROTOCOL,
  HOST_BRIDGE_SESSION_PATH,
  HOST_BRIDGE_TOKEN_VARIABLE,
  hostBridgeCapabilityPath,
  isHostBridgeCapabilityName,
} from "./protocol.js";

export interface HostBridgeCapability {
  readonly name: string;
  handle(
    connection: WebSocketConnection,
    context: { readonly signal: AbortSignal },
  ): Promise<void>;
}

export interface HostBridgeSession extends AsyncDisposable {
  readonly endpoint: string;
  readonly clientEnvironment: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface HostBridgeService {
  startSession(options: {
    readonly containerHostName: string;
    readonly capabilities: readonly HostBridgeCapability[];
  }): Promise<HostBridgeSession>;
}

function tokenMatches(
  header: string | readonly string[] | undefined,
  expected: Buffer,
): boolean {
  const supplied =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice(7)
      : "";
  return timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    expected,
  );
}

function capabilityMap(
  capabilities: readonly HostBridgeCapability[],
): Map<string, HostBridgeCapability> {
  const result = new Map<string, HostBridgeCapability>();
  for (const capability of capabilities) {
    const path = hostBridgeCapabilityPath(capability.name);
    if (!isHostBridgeCapabilityName(capability.name) || result.has(path)) {
      throw new Error("Host bridge capability names must be valid and unique.");
    }
    result.set(path, capability);
  }
  return result;
}

async function dispatch(
  connection: WebSocketConnection,
  capability: HostBridgeCapability,
  sessionSignal: AbortSignal,
): Promise<void> {
  await using resource = connection;
  const disconnected = new AbortController();
  const signal = AbortSignal.any([sessionSignal, disconnected.signal]);
  void connection.closed.then(() => disconnected.abort());
  await capability.handle(resource, { signal });
}

function authorizeUpgrade(options: {
  readonly path: string;
  readonly authorization: string | readonly string[] | undefined;
  readonly capabilities: ReadonlyMap<string, HostBridgeCapability>;
  readonly expectedToken: Buffer;
  readonly signal: AbortSignal;
}): WebSocketUpgradeDecision {
  if (
    options.signal.aborted ||
    !tokenMatches(options.authorization, options.expectedToken)
  ) {
    return { accepted: false, statusCode: 401, reason: "Unauthorized" };
  }
  if (!options.capabilities.has(options.path)) {
    return { accepted: false, statusCode: 404, reason: "Unknown capability" };
  }
  return { accepted: true };
}

async function acceptConnections(options: {
  readonly server: WebSocketServer;
  readonly capabilities: ReadonlyMap<string, HostBridgeCapability>;
  readonly signal: AbortSignal;
  readonly tasks: Set<Promise<void>>;
}): Promise<void> {
  const logger = getLogger();
  for await (const connection of options.server.connections) {
    const capability = options.capabilities.get(connection.path ?? "");
    if (!capability || options.signal.aborted) {
      await connection[Symbol.asyncDispose]();
      continue;
    }
    logger.debug(
      `Dispatching host bridge capability ${chalk.cyan(capability.name)}`,
    );
    const task = dispatch(connection, capability, options.signal).catch(() => {
      if (!options.signal.aborted)
        logger.warn(
          `Host bridge capability ${chalk.cyan(capability.name)} failed.`,
        );
    });
    options.tasks.add(task);
    void task.then(() => options.tasks.delete(task));
  }
}

async function startSession(
  webSockets: WebSocketService,
  options: {
    readonly containerHostName: string;
    readonly capabilities: readonly HostBridgeCapability[];
  },
): Promise<HostBridgeSession> {
  const capabilities = capabilityMap(options.capabilities);
  const logger = getLogger();
  const controller = new AbortController();
  const token = randomBytes(32).toString("base64url");
  const expectedToken = createHash("sha256").update(token).digest();
  const tasks = new Set<Promise<void>>();
  const server = await webSockets.startServer({
    host: "0.0.0.0",
    port: 0,
    maxConnections: HOST_BRIDGE_MAX_CONNECTIONS,
    protocol: HOST_BRIDGE_PROTOCOL,
    maxMessageBytes: HOST_BRIDGE_MAX_MESSAGE_BYTES,
    authorizeUpgrade: ({ path, headers }) =>
      authorizeUpgrade({
        path,
        authorization: headers.authorization,
        capabilities,
        expectedToken,
        signal: controller.signal,
      }),
  });
  const accepting = acceptConnections({
    server,
    capabilities,
    signal: controller.signal,
    tasks,
  });
  logger.debug(`Started encrypted host bridge on port ${server.endpoint.port}`);
  const endpoint = `wss://${options.containerHostName}:${server.endpoint.port}${HOST_BRIDGE_SESSION_PATH}`;
  let disposal: Promise<void> | undefined;
  return {
    signal: controller.signal,
    endpoint,
    clientEnvironment: Object.freeze({
      [HOST_BRIDGE_ENDPOINT_VARIABLE]: endpoint,
      [HOST_BRIDGE_TOKEN_VARIABLE]: token,
      [HOST_BRIDGE_CERTIFICATE_VARIABLE]: server.certificate,
    }),
    [Symbol.asyncDispose]() {
      disposal ??= (async () => {
        controller.abort();
        await server[Symbol.asyncDispose]();
        await accepting;
        await Promise.all(tasks);
        logger.debug("Stopped host bridge session");
      })();
      return disposal;
    },
  };
}

export function createHostBridgeService(
  webSockets: WebSocketService,
): HostBridgeService {
  return { startSession: (options) => startSession(webSockets, options) };
}

const dependency = createDependency<HostBridgeService>("Host bridge service");
export function provideHostBridgeService(
  service: HostBridgeService,
): DependencyBinding {
  return dependency.provide(service);
}
export function getHostBridgeService(): HostBridgeService {
  return dependency.get();
}
