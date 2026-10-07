import { describe, expect, test } from "bun:test";
import { createSystemClock } from "#platform/clock/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import {
  createNodeWebSocketService,
  provideWebSocketService,
  type WebSocketConnection,
} from "#platform/websocket/index.js";
import { openHostBridgeConnection } from "./client.js";
import {
  HOST_BRIDGE_CERTIFICATE_VARIABLE,
  HOST_BRIDGE_ENDPOINT_VARIABLE,
  HOST_BRIDGE_MAX_MESSAGE_BYTES,
  HOST_BRIDGE_PROTOCOL,
  HOST_BRIDGE_TOKEN_VARIABLE,
} from "./protocol.js";
import {
  createHostBridgeService,
  getHostBridgeService,
  type HostBridgeCapability,
  provideHostBridgeService,
} from "./session.js";

async function fixture(capabilities: readonly HostBridgeCapability[]) {
  const webSockets = createNodeWebSocketService();
  const warnings: string[] = [];
  const service = createHostBridgeService(webSockets);
  const logger = createLogger(createSystemClock(), (message) =>
    warnings.push(message),
  );
  const session = await runWithDependencies([provideLogger(logger)], () =>
    service.startSession({ containerHostName: "127.0.0.1", capabilities }),
  );
  return {
    session,
    warnings,
    connect(
      capability = "echo",
      environment = session.clientEnvironment,
      signal?: AbortSignal,
    ) {
      return runWithDependencies([provideWebSocketService(webSockets)], () =>
        openHostBridgeConnection({
          capability,
          environment,
          ...(signal ? { signal } : {}),
        }),
      );
    },
    rawConnect(path: string, headers: Record<string, string> = {}) {
      return webSockets.connect({
        url: `${session.clientEnvironment[HOST_BRIDGE_ENDPOINT_VARIABLE]}${path}`,
        protocol: HOST_BRIDGE_PROTOCOL,
        maxMessageBytes: HOST_BRIDGE_MAX_MESSAGE_BYTES,
        pinnedCertificate:
          session.clientEnvironment[HOST_BRIDGE_CERTIFICATE_VARIABLE] ?? "",
        headers,
      });
    },
    [Symbol.asyncDispose]: () => session[Symbol.asyncDispose](),
  };
}

const echo: HostBridgeCapability = {
  name: "echo",
  async handle(connection) {
    for await (const message of connection.messages) {
      if (message.type === "binary") await connection.sendBinary(message.data);
      else await connection.sendText(message.data);
    }
  },
};

async function nextMessage(connection: WebSocketConnection) {
  const result = await connection.messages[Symbol.asyncIterator]().next();
  if (result.done) throw new Error("Connection ended before response.");
  return result.value;
}

describe("host bridge sessions", () => {
  test("routes authenticated binary and text traffic over a private pinned certificate", async () => {
    await using bridge = await fixture([echo]);
    expect(
      bridge.session.clientEnvironment[HOST_BRIDGE_ENDPOINT_VARIABLE],
    ).toStartWith("wss://");
    await using connection = await bridge.connect();
    await connection.sendText("text");
    expect(await nextMessage(connection)).toEqual({
      type: "text",
      data: "text",
    });
    const bytes = Uint8Array.of(0, 255, 13, 10, 128);
    await connection.sendBinary(bytes);
    expect(await nextMessage(connection)).toEqual({
      type: "binary",
      data: bytes,
    });
  });

  test("rejects missing, incorrect and other-session credentials before dispatch", async () => {
    let calls = 0;
    const capability: HostBridgeCapability = {
      name: "echo",
      async handle() {
        calls += 1;
      },
    };
    await using first = await fixture([capability]);
    await using second = await fixture([echo]);
    await expect(first.rawConnect("/echo")).rejects.toThrow();
    for (const token of [
      "invalid",
      "",
      second.session.clientEnvironment[HOST_BRIDGE_TOKEN_VARIABLE] ?? "",
    ]) {
      await expect(
        first.rawConnect("/echo", { authorization: `Bearer ${token}` }),
      ).rejects.toThrow();
    }
    await expect(
      first.connect("echo", {
        ...first.session.clientEnvironment,
        [HOST_BRIDGE_CERTIFICATE_VARIABLE]:
          second.session.clientEnvironment[HOST_BRIDGE_CERTIFICATE_VARIABLE] ??
          "",
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("rejects unknown capabilities without entering a registered handler", async () => {
    let calls = 0;
    await using bridge = await fixture([
      {
        name: "echo",
        async handle() {
          calls += 1;
        },
      },
    ]);
    await expect(bridge.connect("not-granted")).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("revokes sessions, cancels handlers, and waits for handler cleanup", async () => {
    const started = Promise.withResolvers<void>();
    let cleaned = false;
    await using bridge = await fixture([
      {
        name: "echo",
        async handle(_connection, { signal }) {
          started.resolve();
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          cleaned = true;
        },
      },
    ]);
    await using connection = await bridge.connect();
    await started.promise;
    await bridge.session[Symbol.asyncDispose]();
    expect(bridge.session.signal.aborted).toBe(true);
    expect(cleaned).toBe(true);
    await connection.closed;
    await expect(bridge.connect()).rejects.toThrow();
  });

  test("cancels a capability when the client aborts its connection", async () => {
    const cancelled = Promise.withResolvers<void>();
    await using bridge = await fixture([
      {
        name: "echo",
        async handle(_connection, { signal }) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          cancelled.resolve();
        },
      },
    ]);
    const controller = new AbortController();
    await using connection = await bridge.connect(
      "echo",
      bridge.session.clientEnvironment,
      controller.signal,
    );
    controller.abort();
    await cancelled.promise;
    await connection.closed;
    expect(bridge.session.signal.aborted).toBe(false);
  });

  test("closes failed capability connections and reports no raw operation data", async () => {
    await using bridge = await fixture([
      {
        name: "echo",
        async handle() {
          throw new Error("private content");
        },
      },
    ]);
    await using connection = await bridge.connect();
    await connection.closed;
    expect(bridge.warnings.join("\n")).toContain("capability echo failed");
    expect(bridge.warnings.join("\n")).not.toContain("private content");
  });

  test("rejects duplicate and invalid capability registrations", async () => {
    await expect(fixture([echo, echo])).rejects.toThrow("valid and unique");
    await expect(fixture([{ ...echo, name: "../echo" }])).rejects.toThrow(
      "valid and unique",
    );
  });

  test("rejects plaintext and malformed client endpoints", async () => {
    await using bridge = await fixture([echo]);
    for (const endpoint of [
      "ws://localhost/session",
      "wss://localhost/other",
      "wss://user:pass@localhost/session",
    ]) {
      await expect(
        bridge.connect("echo", {
          ...bridge.session.clientEnvironment,
          [HOST_BRIDGE_ENDPOINT_VARIABLE]: endpoint,
        }),
      ).rejects.toThrow("Invalid encrypted");
    }
    await expect(bridge.connect("echo", {})).rejects.toThrow(
      "No active host bridge",
    );
  });

  test("bounds the number of simultaneous connections", async () => {
    await using bridge = await fixture([echo]);
    await using connections = new AsyncDisposableStack();
    for (let index = 0; index < 32; index += 1)
      connections.use(await bridge.connect());
    await expect(bridge.connect()).rejects.toThrow();
  });

  test("provides the bridge through the dependency scope", () => {
    const service = createHostBridgeService(createNodeWebSocketService());
    runWithDependencies([provideHostBridgeService(service)], () =>
      expect(getHostBridgeService()).toBe(service),
    );
  });
});
