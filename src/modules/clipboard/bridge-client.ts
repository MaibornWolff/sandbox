import { randomInt } from "node:crypto";
import { openHostBridgeConnection } from "#modules/host-bridge/index.js";
import {
  isNativeClipboardFormat,
  type NativeClipboardFormat,
} from "#platform/native-clipboard/index.js";
import type {
  WebSocketConnection,
  WebSocketMessage,
} from "#platform/websocket/index.js";
import {
  CLIPBOARD_READ,
  CLIPBOARD_WRITE,
  expectControl,
  protocolError,
  readResponse,
  receivePayload,
  sendControl,
  sendPayload,
  validateContent,
  validateLength,
} from "./protocol.js";
import {
  createSlotLimiter,
  MAX_CONCURRENT_TRANSFERS,
  withClipboardDeadline,
} from "./request-scope.js";

async function exchange(
  connection: WebSocketConnection,
  iterator: AsyncIterator<WebSocketMessage>,
  options: {
    readonly id: number;
    readonly signal: AbortSignal;
    readonly message: Record<string, unknown>;
    readonly expect: string;
    readonly keys?: readonly string[];
  },
): Promise<Record<string, unknown>> {
  await sendControl(
    connection,
    { ...options.message, id: options.id },
    options.signal,
  );
  const response = await readResponse(iterator);
  expectControl(response, options.expect, options.id, options.keys ?? []);
  return response;
}

export function createClipboardBridgeClient(
  environment: Readonly<Record<string, string | undefined>>,
) {
  const reserve = createSlotLimiter(
    MAX_CONCURRENT_TRANSFERS,
    () => new Error("Clipboard is busy."),
  );
  async function request<T>(
    capability: string,
    signal: AbortSignal,
    operation: (
      connection: WebSocketConnection,
      iterator: AsyncIterator<WebSocketMessage>,
      id: number,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    using _slot = reserve();
    await using connection = await openHostBridgeConnection({
      capability,
      environment,
      signal,
    });
    return await withClipboardDeadline(connection, signal, (deadline) =>
      operation(
        connection,
        connection.messages[Symbol.asyncIterator](),
        randomInt(1, 0x1_0000_0000),
        deadline,
      ),
    );
  }
  return {
    async ready(signal: AbortSignal): Promise<void> {
      for (const capability of [CLIPBOARD_READ, CLIPBOARD_WRITE]) {
        await request(
          capability,
          signal,
          async (connection, it, id, deadline) => {
            await exchange(connection, it, {
              id,
              signal: deadline,
              message: { type: "probe" },
              expect: "ready",
            });
          },
        );
      }
    },
    discover(signal: AbortSignal): Promise<readonly NativeClipboardFormat[]> {
      return request(
        CLIPBOARD_READ,
        signal,
        async (connection, it, id, deadline) => {
          const response = await exchange(connection, it, {
            id,
            signal: deadline,
            message: { type: "discover" },
            expect: "formats",
            keys: ["formats"],
          });
          if (
            !Array.isArray(response.formats) ||
            response.formats.length > 2 ||
            !response.formats.every(isNativeClipboardFormat) ||
            new Set(response.formats).size !== response.formats.length
          )
            throw protocolError();
          return response.formats;
        },
      );
    },
    read(
      format: NativeClipboardFormat,
      signal: AbortSignal,
    ): Promise<Uint8Array> {
      return request(
        CLIPBOARD_READ,
        signal,
        async (connection, it, id, deadline) => {
          const response = await exchange(connection, it, {
            id,
            signal: deadline,
            message: { type: "read", format },
            expect: "content",
            keys: ["format", "bytes"],
          });
          if (response.format !== format) throw protocolError();
          validateLength(format, response.bytes);
          return receivePayload(it, {
            id,
            format,
            bytes: response.bytes,
            signal: deadline,
          });
        },
      );
    },
    publish(
      item: {
        readonly format: NativeClipboardFormat;
        readonly data: Uint8Array;
        readonly generation: number;
      },
      signal: AbortSignal,
    ): Promise<void> {
      validateContent(item.format, item.data);
      return request(
        CLIPBOARD_WRITE,
        signal,
        async (connection, it, id, deadline) => {
          await exchange(connection, it, {
            id,
            signal: deadline,
            message: {
              type: "publish",
              format: item.format,
              bytes: item.data.byteLength,
              generation: item.generation,
            },
            expect: "accepted",
          });
          await sendPayload(connection, id, item.data, deadline);
          expectControl(await readResponse(it), "published", id, []);
        },
      );
    },
  };
}
