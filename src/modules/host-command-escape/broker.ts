import * as path from "node:path";
import {
  chunkHostBridgePayload,
  type HostBridgeCapability,
} from "#modules/host-bridge/index.js";
import { getClock, waitWithTimeout } from "#platform/clock/index.js";
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
import type {
  WebSocketConnection,
  WebSocketMessage,
} from "#platform/websocket/index.js";
import { isFileNotFoundError } from "#shared/errors/index.js";
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
  parseClientControlMessage,
  STREAM_CHANNEL,
} from "./protocol.js";

export interface CreateHostCommandCapabilityOptions {
  readonly commandRules: readonly CommandPattern[];
  readonly hostProjectRoot: string;
  readonly containerProjectRoot: string;
}

export interface HostCommandCapability
  extends HostBridgeCapability,
    AsyncDisposable {
  forwardSignal(signal: NodeJS.Signals): Promise<boolean>;
}

type ActiveChild = ManagedStreamingProcess;

interface BrokerContext {
  readonly children: Set<ActiveChild>;
  readonly connections: Set<WebSocketConnection>;
  readonly rules: readonly CompiledCommandPattern[];
  readonly canonicalPatterns: readonly string[];
  readonly hostProjectRoot: string;
  readonly canonicalHostProjectRoot: string;
  readonly containerProjectRoot: string;
  disposed: boolean;
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
  platform: string,
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
  const pathApi = platform === "win32" ? path.win32 : path.posix;
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
    for (const frame of chunkHostBridgePayload(chunk, 1)) {
      await connection.sendBinary(encodeBinaryChannel(channel, frame));
    }
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

interface CommandRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly signal: AbortSignal;
}

function createCommandRunner(
  logger: Logger,
  environment: HostEnvironment,
  processes: ProcessManager,
) {
  async function reportProtocolFailure(
    connection: WebSocketConnection,
    child: ManagedStreamingProcess | undefined,
    error: unknown,
  ): Promise<void> {
    logger.warn(
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

  async function authorizeCommand(
    connection: WebSocketConnection,
    context: BrokerContext,
    request: CommandRequest,
  ): Promise<string | undefined> {
    if (
      !context.rules.some((rule) => evaluateCommandPattern(rule, request.argv))
    ) {
      const commandDisplay = request.argv.join(" ");
      logger.debug(
        `Denied host command ${request.argv[0]} [arguments redacted]`,
      );
      await denyExecution(
        connection,
        `sandbox escape: command is not allowed: ${commandDisplay}`,
      );
      return undefined;
    }
    try {
      return await mapWorkingDirectory(
        context,
        request.cwd,
        environment.platform,
      );
    } catch {
      logger.debug(
        `Denied host command working directory for ${request.argv[0]} [arguments redacted]`,
      );
      await denyExecution(
        connection,
        `sandbox escape: working directory is not allowed: ${request.cwd}`,
      );
      return undefined;
    }
  }

  async function pipeProcess(
    connection: WebSocketConnection,
    messages: WebSocketConnection["messages"],
    child: ManagedStreamingProcess,
    argv: readonly string[],
  ): Promise<void> {
    await connection.sendText(encodeControlMessage({ type: "ready" }));
    const input = consumeProcessInput(messages, child).catch((error: unknown) =>
      reportProtocolFailure(connection, child, error),
    );
    const output = Promise.allSettled([
      forwardOutput(connection, STREAM_CHANNEL.stdout, child.stdout),
      forwardOutput(connection, STREAM_CHANNEL.stderr, child.stderr),
    ]);
    const result = await child.result;
    const outputFailure = (await output).find(
      (item): item is PromiseRejectedResult => item.status === "rejected",
    );
    if (outputFailure) throw outputFailure.reason;
    logger.debug(`Host command ${argv[0]} exited with code ${result.exitCode}`);
    await sendExit(
      connection,
      result.signal ? getExitCodeForSignal(result.signal) : result.exitCode,
    );
    await input;
  }

  async function executeCommand(
    connection: WebSocketConnection,
    messages: WebSocketConnection["messages"],
    context: BrokerContext,
    request: CommandRequest,
  ): Promise<void> {
    const cwd = await authorizeCommand(connection, context, request);
    if (cwd === undefined) return;
    if (context.disposed || request.signal.aborted) return;
    logger.debug(
      `Starting host command ${request.argv[0]} [arguments redacted]`,
    );
    const child = processes.start({
      lifetime: "application",
      interaction: { mode: "non-interactive" },
      stdio: "stream",
      command: request.argv[0] ?? "",
      args: request.argv.slice(1),
      cwd,
      env: environment.variables,
    });
    context.children.add(child);
    let complete = false;
    const stopOnClose = connection.closed
      .then(() => (complete ? undefined : child.stop()))
      .catch(() => undefined);
    try {
      await pipeProcess(connection, messages, child, request.argv);
      complete = true;
    } catch (error) {
      complete = true;
      if (isFileNotFoundError(error))
        await sendExit(connection, 127).catch(() => undefined);
      else await reportProtocolFailure(connection, child, error);
    } finally {
      context.children.delete(child);
      await child.dispose().catch(() => undefined);
      await stopOnClose;
    }
  }

  return { executeCommand, reportProtocolFailure };
}

function createSessionHandlers(
  logger: Logger,
  environment: HostEnvironment,
  processes: ProcessManager,
) {
  const { executeCommand, reportProtocolFailure } = createCommandRunner(
    logger,
    environment,
    processes,
  );
  async function handleConnection(
    connection: WebSocketConnection,
    context: BrokerContext,
    signal: AbortSignal,
  ): Promise<void> {
    context.connections.add(connection);
    try {
      const iterator = connection.messages[Symbol.asyncIterator]();
      const initial = await waitWithTimeout(iterator.next(), {
        clock: getClock(),
        milliseconds: 5000,
      });
      if (!initial.completed)
        throw new Error("Host command request timed out.");
      const first = initial.value;
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
        await executeCommand(connection, remainingMessages, context, {
          ...operation,
          signal,
        });
      } else {
        throw new Error("The first message must be list or execute.");
      }
    } catch (error) {
      await reportProtocolFailure(connection, undefined, error);
    } finally {
      context.connections.delete(connection);
      await Promise.resolve(connection[Symbol.asyncDispose]()).catch(
        () => undefined,
      );
    }
  }

  async function forwardSignalToChildren(
    context: BrokerContext,
    signal: NodeJS.Signals,
  ): Promise<boolean> {
    if (context.disposed) return false;
    const children = [...context.children];
    if (children.length === 0) return false;
    logger.debug(
      `Forwarding ${signal} to active host command escape processes`,
    );
    const outcomes = await Promise.allSettled(
      children.map((child) => child.stop({ signal })),
    );
    const failures = outcomes.filter(
      (outcome) => outcome.status === "rejected",
    ).length;
    if (failures > 0) {
      logger.warn(
        `Failed to forward ${signal} to ${failures} host command escape process(es)`,
      );
    }
    return failures < outcomes.length;
  }

  async function disposeSession(context: BrokerContext): Promise<void> {
    context.disposed = true;
    logger.debug("Stopping host command escape session");
    await Promise.allSettled(
      [...context.children].map((child) => child.stop()),
    );
    await Promise.allSettled(
      [...context.connections].map((connection) =>
        connection[Symbol.asyncDispose](),
      ),
    );
    await Promise.allSettled(
      [...context.children].map((child) => child.dispose()),
    );
    logger.debug("Stopped host command escape session");
  }

  return { handleConnection, forwardSignalToChildren, disposeSession };
}

export async function createHostCommandCapability(
  options: CreateHostCommandCapabilityOptions,
): Promise<HostCommandCapability> {
  const logger = getLogger();
  const environment = getHostEnvironment();
  const processes = getProcessManager();
  const { handleConnection, forwardSignalToChildren, disposeSession } =
    createSessionHandlers(logger, environment, processes);
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
  const canonicalHostProjectRoot = await resolveRealPath(
    options.hostProjectRoot,
  );
  const context: BrokerContext = {
    children: new Set(),
    connections: new Set(),
    rules,
    canonicalPatterns,
    hostProjectRoot: options.hostProjectRoot,
    canonicalHostProjectRoot,
    containerProjectRoot: path.posix.resolve(options.containerProjectRoot),
    disposed: false,
  };
  return {
    name: "host-command",
    async handle(connection, { signal }) {
      if (context.disposed || signal.aborted) return;
      const cancel = () => {
        void connection[Symbol.asyncDispose]();
      };
      signal.addEventListener("abort", cancel, { once: true });
      using cleanup = new DisposableStack();
      cleanup.defer(() => signal.removeEventListener("abort", cancel));
      await handleConnection(connection, context, signal);
    },
    forwardSignal: (signal) => forwardSignalToChildren(context, signal),
    async [Symbol.asyncDispose]() {
      if (context.disposed) return;
      await disposeSession(context);
    },
  };
}
