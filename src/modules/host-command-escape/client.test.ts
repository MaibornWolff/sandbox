import { describe, expect, test } from "bun:test";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createHostEnvironment,
  provideHostEnvironment,
} from "#platform/environment/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { provideProcessManager } from "#platform/process/index.js";
import { createTestTerminal } from "#platform/terminal/__test__/index.js";
import { provideTerminal } from "#platform/terminal/index.js";
import {
  provideWebSocketService,
  type WebSocketConnection,
  type WebSocketMessage,
} from "#platform/websocket/index.js";
import { runHostCommandEscape } from "./client.js";
import {
  encodeControlMessage,
  HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE,
  HOST_COMMAND_ESCAPE_PROTOCOL,
  HOST_COMMAND_ESCAPE_PROTOCOL_VARIABLE,
  HOST_COMMAND_ESCAPE_TOKEN_VARIABLE,
} from "./protocol.js";

function createClient(connection: WebSocketConnection) {
  const terminal = createTestTerminal();
  const processes = createProcessTestHarness();
  const environment = createHostEnvironment({
    currentWorkingDirectory: "/workspace",
    homeDirectory: "/home/sandbox",
    variables: {
      [HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE]: "ws://broker/session",
      [HOST_COMMAND_ESCAPE_PROTOCOL_VARIABLE]: HOST_COMMAND_ESCAPE_PROTOCOL,
      [HOST_COMMAND_ESCAPE_TOKEN_VARIABLE]: "token",
    },
    platform: "linux",
    interactive: true,
  });
  return {
    terminal,
    run: () =>
      runWithDependencies(
        [
          provideHostEnvironment(environment),
          provideProcessManager(processes.manager),
          provideTerminal(terminal.io),
          provideWebSocketService({
            startServer: async () => {
              throw new Error("Unexpected server start.");
            },
            connect: async () => connection,
          }),
        ],
        () =>
          runHostCommandEscape({ operation: "execute", argv: ["sleep", "10"] }),
      ),
    async [Symbol.asyncDispose]() {
      await terminal.dispose();
      await processes.dispose();
    },
  };
}

function createConnection(
  options: {
    readonly exitReady?: Promise<void>;
    readonly sendBinary?: WebSocketConnection["sendBinary"];
  } = {},
): WebSocketConnection {
  const messages: AsyncIterable<WebSocketMessage> = {
    async *[Symbol.asyncIterator]() {
      yield { type: "text", data: encodeControlMessage({ type: "ready" }) };
      await options.exitReady;
      yield {
        type: "text",
        data: encodeControlMessage({ type: "exit", exitCode: 130 }),
      };
    },
  };
  return {
    protocol: HOST_COMMAND_ESCAPE_PROTOCOL,
    messages,
    closed: Promise.resolve({ code: 1000, reason: "", wasClean: true }),
    sendText: async () => undefined,
    sendBinary: options.sendBinary ?? (async () => undefined),
    close: async () => ({ code: 1000, reason: "", wasClean: true }),
    async [Symbol.asyncDispose]() {},
  };
}

describe("host command escape client input", () => {
  test("releases stdin when a command exits without consuming input", async () => {
    await using client = createClient(createConnection());
    await expect(client.run()).rejects.toMatchObject({ exitCode: 130 });
    expect(client.terminal.io.input.isPaused()).toBe(true);
  });

  test("settles when exit stops stdin during a pending send", async () => {
    const exitReady = Promise.withResolvers<void>();
    const binaryStarted = Promise.withResolvers<void>();
    const binaryRelease = Promise.withResolvers<void>();
    await using client = createClient(
      createConnection({
        exitReady: exitReady.promise,
        sendBinary: async () => {
          binaryStarted.resolve();
          await binaryRelease.promise;
        },
      }),
    );
    const running = client.run();
    await client.terminal.user.inputChunks("\u0003");
    await binaryStarted.promise;
    exitReady.resolve();
    await Promise.resolve();
    binaryRelease.resolve();
    await expect(
      Promise.race([
        running,
        Bun.sleep(100).then(() => {
          throw new Error("Host command escape client did not settle.");
        }),
      ]),
    ).rejects.toMatchObject({ exitCode: 130 });
  });
});
