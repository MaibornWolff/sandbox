import { describe, expect, test } from "bun:test";
import {
  chunkHostBridgePayload,
  HOST_BRIDGE_MAX_MESSAGE_BYTES,
} from "./protocol.js";

describe("host bridge binary chunks", () => {
  test("keeps payload bytes and reserves framing space below the message limit", () => {
    const input = Buffer.alloc(HOST_BRIDGE_MAX_MESSAGE_BYTES * 2 + 17, 213);
    const chunks = [...chunkHostBridgePayload(input, 1)];
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([
      HOST_BRIDGE_MAX_MESSAGE_BYTES - 1,
      HOST_BRIDGE_MAX_MESSAGE_BYTES - 1,
      19,
    ]);
    expect(Buffer.concat(chunks)).toEqual(input);
    expect([...chunkHostBridgePayload(new Uint8Array())]).toEqual([]);
  });

  test("rejects invalid frame reservations", () => {
    for (const size of [-1, 0.5, Number.NaN, HOST_BRIDGE_MAX_MESSAGE_BYTES]) {
      expect(() => [...chunkHostBridgePayload(Uint8Array.of(1), size)]).toThrow(
        "Invalid host bridge frame reservation",
      );
    }
  });
});
