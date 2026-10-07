import { describe, expect, test } from "bun:test";
import { HOST_BRIDGE_TOKEN_VARIABLE } from "#modules/host-bridge/__test__/index.js";
import {
  createHostBridgeService,
  openHostBridgeConnection,
} from "#modules/host-bridge/index.js";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { provideClock } from "#platform/clock/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import { createFakeNativeClipboardService } from "#platform/native-clipboard/__test__/index.js";
import {
  createNodeWebSocketService,
  provideWebSocketService,
} from "#platform/websocket/index.js";
import { createClipboardTestImage } from "./__test__/index.js";
import { createClipboardBridgeClient } from "./bridge-client.js";
import { createClipboardCapabilityFactory } from "./host-capability.js";
import { CLIPBOARD_WRITE, nextMessage, parseControl } from "./protocol.js";

async function withClipboard(
  operation: (
    fixture: Awaited<ReturnType<typeof createFixture>>,
  ) => Promise<void>,
) {
  const clock = createTestClock();
  const webSockets = createNodeWebSocketService();
  const logs: string[] = [];
  return runWithDependencies(
    [
      provideClock(clock.clock),
      provideLogger(createLogger(clock.clock, (message) => logs.push(message))),
      provideWebSocketService(webSockets),
    ],
    async () => {
      await using fixture = await createFixture(webSockets, clock, logs);
      await operation(fixture);
    },
  );
}

async function createFixture(
  webSockets = createNodeWebSocketService(),
  clock = createTestClock(),
  logs: string[] = [],
) {
  const resources = new AsyncDisposableStack();
  const native = resources.use(createFakeNativeClipboardService());
  const factory = createClipboardCapabilityFactory(native);
  const capabilities = resources.use(factory.create());
  const service = createHostBridgeService(webSockets);
  const session = resources.use(
    await service.startSession({
      containerHostName: "127.0.0.1",
      capabilities: capabilities.capabilities,
    }),
  );
  const client = createClipboardBridgeClient(session.clientEnvironment);
  const signal = new AbortController().signal;
  return {
    native,
    factory,
    service,
    session,
    client,
    signal,
    clock,
    logs,
    connect: () =>
      openHostBridgeConnection({
        capability: CLIPBOARD_WRITE,
        environment: session.clientEnvironment,
      }),
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}

describe("clipboard capabilities over the authenticated bridge", () => {
  test("works without host command permission and reads new Unicode or PNG for each paste", () =>
    withClipboard(async ({ native, client, signal }) => {
      await client.ready(signal);
      expect(native.publications).toHaveLength(0);
      expect(await client.discover(signal)).toEqual([]);
      const text = Buffer.from("Hello 世界 🦊\n".repeat(20_000));
      native.replace({ format: "text/plain", data: text });
      expect(await client.discover(signal)).toEqual(["text/plain"]);
      expect(Buffer.from(await client.read("text/plain", signal))).toEqual(
        text,
      );
      const png = createClipboardTestImage();
      expect(png.length).toBeGreaterThan(64 * 1024);
      native.replace({ format: "image/png", data: png });
      expect(await client.discover(signal)).toEqual(["image/png"]);
      expect(
        Buffer.from(await client.read("image/png", signal)).equals(png),
      ).toBe(true);
      await expect(client.read("text/plain", signal)).rejects.toThrow();
      native.replace();
      await expect(client.read("image/png", signal)).rejects.toThrow();
    }));

  test("publishes complete binary snapshots exactly once and rejects replayed generations", () =>
    withClipboard(async ({ native, client, signal }) => {
      const text = Buffer.from("Unicode 🦊".repeat(10_000));
      await client.publish(
        { format: "text/plain", data: text, generation: 1 },
        signal,
      );
      const png = createClipboardTestImage();
      await client.publish(
        { format: "image/png", data: png, generation: 2 },
        signal,
      );
      expect(native.publications).toEqual([
        { format: "text/plain", data: text },
        { format: "image/png", data: png },
      ]);
      await expect(
        client.publish(
          { format: "text/plain", data: text, generation: 2 },
          signal,
        ),
      ).rejects.toThrow();
      expect(native.publications).toHaveLength(2);
    }));

  test.each([
    "short",
    "wrong-id",
    "wrong-offset",
    "invalid-utf8",
    "extra-bytes",
    "wrong-end",
    "binary-before-header",
  ])("rejects %s without invoking a setter", (invalid) =>
    withClipboard(async ({ native, connect, signal }) => {
      await using connection = await connect();
      const iterator = connection.messages[Symbol.asyncIterator]();
      if (invalid === "binary-before-header") {
        await connection.sendBinary(Buffer.alloc(16));
      } else {
        await connection.sendText(
          JSON.stringify({
            type: "publish",
            id: 7,
            format: "text/plain",
            bytes: 1,
            generation: 1,
          }),
        );
        expect(parseControl(await nextMessage(iterator)).type).toBe("accepted");
        const frame = Buffer.alloc(invalid === "extra-bytes" ? 10 : 9);
        frame.writeUInt32BE(invalid === "wrong-id" ? 8 : 7, 0);
        frame.writeUInt32BE(invalid === "wrong-offset" ? 1 : 0, 4);
        frame[8] = invalid === "invalid-utf8" ? 0xff : 65;
        if (invalid !== "short") await connection.sendBinary(frame, { signal });
        await connection.sendText(
          JSON.stringify({
            type: "end",
            id: 7,
            bytes: invalid === "wrong-end" ? 2 : 1,
          }),
        );
      }
      await connection.closed;
      expect(native.publications).toHaveLength(0);
    }),
  );

  test("cancels an incomplete transfer when a newer copy is accepted", () =>
    withClipboard(async ({ native, connect, client, signal }) => {
      await using old = await connect();
      await old.sendText(
        JSON.stringify({
          type: "publish",
          id: 1,
          format: "text/plain",
          bytes: 3,
          generation: 1,
        }),
      );
      expect(
        parseControl(await nextMessage(old.messages[Symbol.asyncIterator]()))
          .type,
      ).toBe("accepted");
      await client.publish(
        { format: "text/plain", data: Buffer.from("new"), generation: 2 },
        signal,
      );
      await old.closed;
      expect(native.publications).toEqual([
        { format: "text/plain", data: Buffer.from("new") },
      ]);
    }));

  test("cancels disconnected and timed out partial copies", () =>
    withClipboard(async ({ native, connect, clock }) => {
      await using first = await connect();
      await first.sendText(
        JSON.stringify({
          type: "publish",
          id: 1,
          format: "text/plain",
          bytes: 3,
          generation: 1,
        }),
      );
      await nextMessage(first.messages[Symbol.asyncIterator]());
      await first.close();
      await using second = await connect();
      await second.sendText(
        JSON.stringify({
          type: "publish",
          id: 2,
          format: "text/plain",
          bytes: 3,
          generation: 2,
        }),
      );
      await nextMessage(second.messages[Symbol.asyncIterator]());
      await clock.advanceBy(10_000);
      await second.closed;
      expect(native.publications).toHaveLength(0);
    }));

  test("keeps concurrent session generations independent", () =>
    withClipboard(async ({ native, factory, service, client, signal }) => {
      await using capabilities = factory.create();
      await using session = await service.startSession({
        containerHostName: "127.0.0.1",
        capabilities: capabilities.capabilities,
      });
      const second = createClipboardBridgeClient(session.clientEnvironment);
      await Promise.all([
        client.publish(
          { format: "text/plain", data: Buffer.from("first"), generation: 1 },
          signal,
        ),
        second.publish(
          { format: "text/plain", data: Buffer.from("second"), generation: 1 },
          signal,
        ),
      ]);
      expect(native.publications).toHaveLength(2);
    }));

  test("rejects unauthenticated and revoked reads without revealing raw native errors", () =>
    withClipboard(async ({ session, client, native, logs, signal }) => {
      const unauthenticated = createClipboardBridgeClient({
        ...session.clientEnvironment,
        [HOST_BRIDGE_TOKEN_VARIABLE]: "bad",
      });
      await expect(unauthenticated.discover(signal)).rejects.toThrow();
      native.read = async () => {
        throw new Error("PRIVATE CLIPBOARD CONTENT");
      };
      await expect(client.read("text/plain", signal)).rejects.toThrow();
      expect(logs.join("\n")).not.toContain("PRIVATE CLIPBOARD CONTENT");
      await session[Symbol.asyncDispose]();
      await expect(client.discover(signal)).rejects.toThrow();
    }));
});
