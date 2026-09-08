import { randomBytes, timingSafeEqual } from "node:crypto";
import * as path from "node:path";
import {
  getHostEnvironment,
  type HostEnvironment,
} from "#platform/environment/index.js";
import {
  exists,
  isDirectoryPath,
  resolveRealPath,
} from "#platform/filesystem/index.js";
import { getLogger, type Logger } from "#platform/logging/index.js";
import {
  getExitCodeForSignal,
  getProcessManager,
  type ManagedStreamingProcess,
  type ProcessManager,
} from "#platform/process/index.js";
import {
  getWebSocketService,
  type WebSocketConnection,
  type WebSocketMessage,
  type WebSocketServer,
} from "#platform/websocket/index.js";
import {
  type CompiledCommandPattern,
  compileCommandPattern,
  evaluateCommandPattern,
  formatCommandPattern,
} from "./command-pattern.js";
import type { CommandPattern } from "./matchers.js";
import {
  decodeBinaryChannel,
  encodeBinaryChannel,
  encodeControlMessage,
  HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE,
  HOST_COMMAND_ESCAPE_MAX_MESSAGE_BYTES,
  HOST_COMMAND_ESCAPE_PROTOCOL,
  HOST_COMMAND_ESCAPE_PROTOCOL_VARIABLE,
  HOST_COMMAND_ESCAPE_TOKEN_VARIABLE,
  parseClientControlMessage,
  STREAM_CHANNEL,
} from "./protocol.js";

export interface StartHostCommandEscapeSessionOptions {
  readonly commandRules: readonly CommandPattern[];
  readonly hostProjectRoot: string;
  readonly containerProjectRoot: string;
  readonly containerHostName: string;
}

export interface HostCommandEscapeSession extends AsyncDisposable {
  readonly clientEnvironment: Readonly<Record<string, string>>;
  forwardSignal(signal: NodeJS.Signals): Promise<boolean>;
}

class BrokerContext {
  readonly children = new Set<ManagedStreamingProcess>();
  readonly connections = new Set<WebSocketConnection>();

  constructor(
    readonly rules: readonly CompiledCommandPattern[],
    readonly canonicalPatterns: readonly string[],
    readonly hostProjectRoot: string,
    readonly canonicalHostProjectRoot: string,
    readonly containerProjectRoot: string,
    readonly environment: HostEnvironment,
    readonly processes: ProcessManager,
    readonly logger: Logger,
    readonly disposed: () => boolean,
  ) {}
}

function isWithin(
  root: string,
  candidate: string,
  pathApi: typeof path.posix,
): boolean {
  const relative = pathApi.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relative))
  );
}

async function mapWorkingDirectory(
  context: BrokerContext,
  clientDirectory: string,
): Promise<string> {
  const containerPath = path.posix.resolve(
    context.containerProjectRoot,
    clientDirectory,
  );
  if (!isWithin(context.containerProjectRoot, containerPath, path.posix)) {
    throw new Error("working directory is outside the container project");
  }
  const relative = path.posix.relative(
    context.containerProjectRoot,
    containerPath,
  );
  const pathApi =
    context.environment.platform === "win32" ? path.win32 : path.posix;
  const candidate = pathApi.resolve(
    context.hostProjectRoot,
    ...relative.split("/").filter((part) => part.length > 0),
  );
  if (
    !isWithin(context.hostProjectRoot, candidate, pathApi) ||
    !(await exists(candidate))
  ) {
    throw new Error(
      "working directory is outside or missing from the host project",
    );
  }
  let canonicalCandidate: string;
  try {
    if (!isDirectoryPath(candidate))
      throw new Error("working directory is not a directory");
    canonicalCandidate = await resolveRealPath(candidate);
  } catch (error) {
    throw new Error("working directory is not an accessible host directory", {
      cause: error,
    });
  }
  if (
    !isWithin(context.canonicalHostProjectRoot, canonicalCandidate, pathApi)
  ) {
    throw new Error("working directory resolves outside the host project");
  }
  return canonicalCandidate;
}

function executableMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function sendExit(
  connection: WebSocketConnection,
  exitCode: number,
): Promise<void> {
  await connection.sendText(encodeControlMessage({ type: "exit", exitCode }));
  await connection.close(1000, "complete");
}

async function denyExecution(
  connection: WebSocketConnection,
  message: string,
): Promise<void> {
  await connection.sendBinary(
    encodeBinaryChannel(STREAM_CHANNEL.stderr, Buffer.from(`${message}\n`)),
  );
  await sendExit(connection, 126);
}

async function forwardOutput(
  connection: WebSocketConnection,
  channel: 2 | 3,
  output: AsyncIterable<Uint8Array>,
): Promise<void> {
  for await (const chunk of output) {
    await connection.sendBinary(encodeBinaryChannel(channel, chunk));
  }
}

async function consumeProcessInput(
  messages: AsyncIterable<WebSocketMessage>,
  child: ManagedStreamingProcess,
): Promise<void> {
  for await (const message of messages) {
    if (message.type === "binary") {
      const decoded = decodeBinaryChannel(message.data);
      if (decoded.channel !== STREAM_CHANNEL.stdin) {
        throw new Error(
          "Only the stdin binary channel is accepted from the client.",
        );
      }
      await child.stdin.write(decoded.payload);
      continue;
    }
    const control = parseClientControlMessage(message.data);
    if (control.type === "stdin-end") await child.stdin.end();
    else if (control.type === "signal")
      await child.stop({ signal: control.signal });
    else throw new Error("A connection can contain only one operation.");
  }
}

async function reportProtocolFailure(
  connection: WebSocketConnection,
  context: BrokerContext,
  child: ManagedStreamingProcess | undefined,
  error: unknown,
): Promise<void> {
  context.logger.warn(
    `Host command escape protocol failure: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  await child?.stop().catch(() => undefined);
  await connection
    .sendText(
      encodeControlMessage({
        type: "error",
        code: "PROTOCOL_ERROR",
        message: "Host command escape protocol failed.",
      }),
    )
    .catch(() => undefined);
  await connection.close(1002, "protocol error").catch(() => undefined);
}

async function executeCommand(
  connection: WebSocketConnection,
  messages: WebSocketConnection["messages"],
  context: BrokerContext,
  request: { readonly argv: readonly string[]; readonly cwd: string },
): Promise<void> {
  const commandDisplay = request.argv.join(" ");
  if (
    !context.rules.some((rule) => evaluateCommandPattern(rule, request.argv))
  ) {
    context.logger.debug(
      `Denied host command ${request.argv[0]} [arguments redacted]`,
    );
    await denyExecution(
      connection,
      `sandbox escape: command is not allowed: ${commandDisplay}`,
    );
    return;
  }
  let cwd: string;
  try {
    cwd = await mapWorkingDirectory(context, request.cwd);
  } catch {
    context.logger.debug(
      `Denied host command working directory for ${request.argv[0]} [arguments redacted]`,
    );
    await denyExecution(
      connection,
      `sandbox escape: working directory is not allowed: ${request.cwd}`,
    );
    return;
  }
  if (context.disposed()) return;
  context.logger.debug(
    `Starting host command ${request.argv[0]} [arguments redacted]`,
  );
  const child = context.processes.start({
    lifetime: "application",
    interaction: { mode: "non-interactive" },
    stdio: "stream",
    command: request.argv[0] ?? "",
    args: request.argv.slice(1),
    cwd,
    env: context.environment.variables,
  });
  context.children.add(child);
  let complete = false;
  const stopOnClose = connection.closed
    .then(() => (complete ? undefined : child.stop()))
    .catch(() => undefined);
  try {
    await connection.sendText(encodeControlMessage({ type: "ready" }));
    const input = consumeProcessInput(messages, child).catch((error: unknown) =>
      reportProtocolFailure(connection, context, child, error),
    );
    const output = Promise.allSettled([
      forwardOutput(connection, STREAM_CHANNEL.stdout, child.stdout),
      forwardOutput(connection, STREAM_CHANNEL.stderr, child.stderr),
    ]);
    const result = await child.result;
    const outputResults = await output;
    const outputFailure = outputResults.find(
      (item): item is PromiseRejectedResult => item.status === "rejected",
    );
    if (outputFailure) throw outputFailure.reason;
    complete = true;
    context.logger.debug(
      `Host command ${request.argv[0]} exited with code ${result.exitCode}`,
    );
    await sendExit(
      connection,
      result.signal ? getExitCodeForSignal(result.signal) : result.exitCode,
    );
    await input;
  } catch (error) {
    complete = true;
    if (executableMissing(error))
      await sendExit(connection, 127).catch(() => undefined);
    else await reportProtocolFailure(connection, context, child, error);
  } finally {
    context.children.delete(child);
    await child.dispose().catch(() => undefined);
    await stopOnClose;
  }
}

async function handleConnection(
  connection: WebSocketConnection,
  context: BrokerContext,
): Promise<void> {
  context.connections.add(connection);
  try {
    const iterator = connection.messages[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done || first.value.type !== "text") {
      throw new Error("The first message must be a control operation.");
    }
    const operation = parseClientControlMessage(first.value.data);
    if (operation.type === "list") {
      await connection.sendText(
        encodeControlMessage({
          type: "allowed-commands",
          patterns: context.canonicalPatterns,
        }),
      );
      await connection.close(1000, "complete");
    } else if (operation.type === "execute") {
      const remainingMessages: WebSocketConnection["messages"] = {
        [Symbol.asyncIterator]: () => iterator,
      };
      await executeCommand(connection, remainingMessages, context, operation);
    } else {
      throw new Error("The first message must be list or execute.");
    }
  } catch (error) {
    await reportProtocolFailure(connection, context, undefined, error);
  } finally {
    context.connections.delete(connection);
    await Promise.resolve(connection[Symbol.asyncDispose]()).catch(
      () => undefined,
    );
  }
}

function tokenMatches(
  header: string | readonly string[] | undefined,
  token: string,
): boolean {
  const supplied =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
  const suppliedBytes = Buffer.from(supplied);
  const tokenBytes = Buffer.from(token);
  return (
    suppliedBytes.length === tokenBytes.length &&
    timingSafeEqual(suppliedBytes, tokenBytes)
  );
}

async function forwardSignalToChildren(
  context: BrokerContext,
  signal: NodeJS.Signals,
): Promise<boolean> {
  if (context.disposed()) return false;
  const children = [...context.children];
  if (children.length === 0) return false;
  context.logger.debug(
    `Forwarding ${signal} to active host command escape processes`,
  );
  const outcomes = await Promise.allSettled(
    children.map((child) => child.stop({ signal })),
  );
  const failures = outcomes.filter(
    (outcome) => outcome.status === "rejected",
  ).length;
  if (failures > 0) {
    context.logger.warn(
      `Failed to forward ${signal} to ${failures} host command escape process(es)`,
    );
  }
  return failures < outcomes.length;
}

async function disposeSession(
  server: WebSocketServer,
  context: BrokerContext,
  markDisposed: () => void,
): Promise<void> {
  markDisposed();
  context.logger.debug("Stopping host command escape session");
  await Promise.allSettled([...context.children].map((child) => child.stop()));
  await Promise.allSettled(
    [...context.connections].map((connection) =>
      connection.close(1001, "session ended"),
    ),
  );
  await server[Symbol.asyncDispose]();
  await Promise.allSettled(
    [...context.children].map((child) => child.dispose()),
  );
  context.logger.debug("Stopped host command escape session");
}

export async function startHostCommandEscapeSession(
  options: StartHostCommandEscapeSessionOptions,
): Promise<HostCommandEscapeSession> {
  const logger = getLogger();
  let rules: readonly CompiledCommandPattern[];
  try {
    rules = Object.freeze(options.commandRules.map(compileCommandPattern));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    logger.error(`Failed to compile host command escape policy: ${detail}`);
    throw new Error("Host command escape policy compilation failed.", {
      cause: error,
    });
  }
  const canonicalPatterns = Object.freeze(
    options.commandRules.map(formatCommandPattern),
  );
  const token = randomBytes(32).toString("base64url");
  const canonicalHostProjectRoot = await resolveRealPath(
    options.hostProjectRoot,
  );
  const server = await getWebSocketService().startServer({
    host: "0.0.0.0",
    port: 0,
    protocol: HOST_COMMAND_ESCAPE_PROTOCOL,
    maxMessageBytes: HOST_COMMAND_ESCAPE_MAX_MESSAGE_BYTES,
    authorizeUpgrade: ({ path: requestPath, headers }) => ({
      accepted:
        requestPath === "/session" &&
        tokenMatches(headers.authorization, token),
      statusCode: 401,
      reason: "Unauthorized",
    }),
  });
  let disposed = false;
  const context = new BrokerContext(
    rules,
    canonicalPatterns,
    options.hostProjectRoot,
    canonicalHostProjectRoot,
    path.posix.resolve(options.containerProjectRoot),
    getHostEnvironment(),
    getProcessManager(),
    logger,
    () => disposed,
  );
  void (async () => {
    for await (const connection of server.connections) {
      void handleConnection(connection, context);
    }
  })();
  context.logger.debug(
    `Started host command escape session on port ${server.endpoint.port}`,
  );
  return {
    clientEnvironment: Object.freeze({
      [HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE]: `ws://${options.containerHostName}:${server.endpoint.port}/session`,
      [HOST_COMMAND_ESCAPE_PROTOCOL_VARIABLE]: HOST_COMMAND_ESCAPE_PROTOCOL,
      [HOST_COMMAND_ESCAPE_TOKEN_VARIABLE]: token,
    }),
    forwardSignal: (signal) => forwardSignalToChildren(context, signal),
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      await disposeSession(server, context, () => {
        disposed = true;
      });
    },
  };
}
