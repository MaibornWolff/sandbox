import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  HOST_BRIDGE_CERTIFICATE_VARIABLE,
  HOST_BRIDGE_PROTOCOL as HOST_COMMAND_ESCAPE_PROTOCOL,
  HOST_BRIDGE_TOKEN_VARIABLE as HOST_COMMAND_ESCAPE_TOKEN_VARIABLE,
} from "#modules/host-bridge/__test__/index.js";
import { HOST_BRIDGE_ENDPOINT_VARIABLE as HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE } from "#modules/host-bridge/index.js";
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
  decodeBinaryChannel,
  encodeControlMessage,
  parseClientControlMessage,
} from "./protocol.js";

function createClient(connection: WebSocketConnection) {
  const terminal = createTestTerminal();
  const processes = createProcessTestHarness();
  const environment = createHostEnvironment({
    currentWorkingDirectory: "/workspace",
    homeDirectory: "/home/sandbox",
    variables: {
      [HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE]: "wss://broker/session",
      [HOST_BRIDGE_CERTIFICATE_VARIABLE]: "test-certificate",
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
    readonly disconnect?: boolean;
    readonly sendBinary?: WebSocketConnection["sendBinary"];
    readonly sendText?: WebSocketConnection["sendText"];
  } = {},
): WebSocketConnection {
  const messages: AsyncIterable<WebSocketMessage> = {
    async *[Symbol.asyncIterator]() {
      yield { type: "text", data: encodeControlMessage({ type: "ready" }) };
      await options.exitReady;
      if (options.disconnect) return;
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
    sendText: options.sendText ?? (async () => undefined),
    sendBinary: options.sendBinary ?? (async () => undefined),
    close: async () => ({ code: 1000, reason: "", wasClean: true }),
    async [Symbol.asyncDispose]() {},
  };
}

describe("host command escape client input", () => {
  test("sends pipe EOF when input ends during a pending transfer", async () => {
    const exitReady = Promise.withResolvers<void>();
    const binaryStarted = Promise.withResolvers<void>();
    const binaryRelease = Promise.withResolvers<void>();
    const controlTypes: string[] = [];
    const payloads: Uint8Array[] = [];
    await using client = createClient(
      createConnection({
        exitReady: exitReady.promise,
        sendText: async (data) => {
          controlTypes.push(parseClientControlMessage(data).type);
        },
        sendBinary: async (data) => {
          payloads.push(decodeBinaryChannel(data).payload);
          binaryStarted.resolve();
          await binaryRelease.promise;
        },
      }),
    );
    const ended = once(client.terminal.io.input, "end");
    client.terminal.user.endInput("input-data\n");
    const running = client.run();
    await binaryStarted.promise;
    await ended;
    binaryRelease.resolve();
    await nextTurn();
    exitReady.resolve();
    await expect(running).rejects.toMatchObject({ exitCode: 130 });
    expect(Buffer.concat(payloads).toString()).toBe("input-data\n");
    expect(controlTypes).toEqual(["execute", "stdin-end"]);
  });

  test("awaits a cancelled stdin send when the broker disconnects", async () => {
    const disconnect = Promise.withResolvers<void>();
    const binaryStarted = Promise.withResolvers<void>();
    const cancellationStarted = Promise.withResolvers<void>();
    const cancellationRelease = Promise.withResolvers<void>();
    await using client = createClient(
      createConnection({
        exitReady: disconnect.promise,
        disconnect: true,
        sendBinary: async (_data, options) => {
          if (!options?.signal)
            throw new Error("Missing stdin cancellation signal.");
          binaryStarted.resolve();
          await once(options.signal, "abort");
          cancellationStarted.resolve();
          await cancellationRelease.promise;
          throw new Error("send cancelled");
        },
      }),
    );
    const running = client.run();
    let settled = false;
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await client.terminal.user.inputChunks("input-data");
    await binaryStarted.promise;
    disconnect.resolve();
    await cancellationStarted.promise;
    await nextTurn();
    const settledBeforeRelease = settled;
    cancellationRelease.resolve();
    await expect(running).rejects.toMatchObject({ exitCode: 1 });
    expect(client.terminal.stderr()).toContain(
      "Host command escape broker closed before the command exited.",
    );
    expect(client.terminal.stderr()).not.toContain("send cancelled");
    expect(settledBeforeRelease).toBe(false);
    expect(client.terminal.io.input.isPaused()).toBe(true);
  });

  test("cancels a pending EOF send when the command exits", async () => {
    const eofStarted = Promise.withResolvers<void>();
    let cancelled = false;
    await using client = createClient(
      createConnection({
        exitReady: eofStarted.promise,
        sendText: async (data, options) => {
          if (parseClientControlMessage(data).type !== "stdin-end") return;
          eofStarted.resolve();
          if (!options?.signal) {
            throw new Error("Missing stdin EOF cancellation signal.");
          }
          await once(options.signal, "abort");
          cancelled = true;
          throw new Error("EOF send cancelled");
        },
      }),
    );
    client.terminal.user.endInput();
    await expect(client.run()).rejects.toMatchObject({ exitCode: 130 });
    expect(cancelled).toBe(true);
    expect(client.terminal.io.input.isPaused()).toBe(true);
    expect(client.terminal.stderr()).toBe("");
  });

  test("closes the broker when stdin forwarding fails before command exit", async () => {
    const closed = Promise.withResolvers<void>();
    const closures: Array<{
      code: number | undefined;
      reason: string | undefined;
    }> = [];
    const connection = createConnection({
      exitReady: closed.promise,
      disconnect: true,
      sendBinary: async () => {
        throw new Error("stdin write failed");
      },
    });
    await using client = createClient({
      ...connection,
      async close(code, reason) {
        closures.push({ code, reason });
        closed.resolve();
        return connection.close(code, reason);
      },
    });
    client.terminal.user.endInput("input-data");
    await expect(client.run()).rejects.toMatchObject({ exitCode: 1 });
    expect(closures).toEqual([
      { code: 1011, reason: "stdin-forwarding-failed" },
    ]);
    expect(client.terminal.stderr()).toContain(
      "Host command escape broker closed before the command exited.",
    );
    expect(client.terminal.io.input.isPaused()).toBe(true);
  });

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
