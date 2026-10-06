import {
  NATIVE_CLIPBOARD_ERROR_CODES,
  type NativeClipboardFormat,
} from "#platform/native-clipboard/index.js";
import type {
  WebSocketConnection,
  WebSocketMessage,
} from "#platform/websocket/index.js";
import { validatePng } from "./png.js";

export const CLIPBOARD_READ = "clipboard-read";
export const CLIPBOARD_WRITE = "clipboard-write";
const CHUNK_BYTES = 64 * 1024;
export const OPERATION_TIMEOUT = 10_000;
const FAILURE_CODES: ReadonlySet<string> = new Set([
  ...NATIVE_CLIPBOARD_ERROR_CODES,
  "invalid-content",
  "timeout",
  "transfer-failed",
]);
const TEXT_BYTES = 4 * 1024 * 1024;
const IMAGE_BYTES = 32 * 1024 * 1024;

export function protocolError(): Error {
  return new Error("Clipboard transfer is invalid or incomplete.");
}

export function isUint(
  value: unknown,
  range: { readonly min: number; readonly max: number },
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= range.min &&
    value <= range.max
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

export function parseControl(
  message: WebSocketMessage,
): Record<string, unknown> {
  if (message.type !== "text" || message.data.length > 1024)
    throw protocolError();
  const value: unknown = JSON.parse(message.data);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw protocolError();
  return value as Record<string, unknown>;
}

export async function readResponse(
  iterator: AsyncIterator<WebSocketMessage>,
): Promise<Record<string, unknown>> {
  const response = parseControl(await nextMessage(iterator));
  if (response.type === "error") {
    if (
      typeof response.code !== "string" ||
      !FAILURE_CODES.has(response.code) ||
      !hasExactKeys(response, ["type", "code"])
    )
      throw protocolError();
    throw new Error(`Clipboard operation failed: ${response.code}.`);
  }
  return response;
}

export function expectControl(
  value: Record<string, unknown>,
  type: string,
  id: number,
  keys: readonly string[],
): void {
  if (
    value.type !== type ||
    value.id !== id ||
    !hasExactKeys(value, ["type", "id", ...keys])
  )
    throw protocolError();
}

export function validateLength(
  format: NativeClipboardFormat,
  length: unknown,
): asserts length is number {
  const max = format === "text/plain" ? TEXT_BYTES : IMAGE_BYTES;
  if (!isUint(length, { min: 0, max })) throw protocolError();
}

export function validateContent(
  format: NativeClipboardFormat,
  data: Uint8Array,
): void {
  validateLength(format, data.byteLength);
  if (format === "text/plain") {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return;
  }
  try {
    validatePng(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  } catch {
    throw protocolError();
  }
}

export async function nextMessage(
  iterator: AsyncIterator<WebSocketMessage>,
): Promise<WebSocketMessage> {
  const result = await iterator.next();
  if (result.done) throw protocolError();
  return result.value;
}

export async function sendControl(
  connection: WebSocketConnection,
  value: Record<string, unknown>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await connection.sendText(JSON.stringify(value), { signal });
}

export async function sendPayload(
  connection: WebSocketConnection,
  id: number,
  data: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  for (let offset = 0; offset < data.byteLength; offset += CHUNK_BYTES) {
    const chunk = data.subarray(offset, offset + CHUNK_BYTES);
    const frame = Buffer.allocUnsafe(8 + chunk.byteLength);
    frame.writeUInt32BE(id, 0);
    frame.writeUInt32BE(offset, 4);
    frame.set(chunk, 8);
    signal.throwIfAborted();
    await connection.sendBinary(frame, { signal });
  }
  await sendControl(
    connection,
    { type: "end", id, bytes: data.byteLength },
    signal,
  );
}

export async function receivePayload(
  iterator: AsyncIterator<WebSocketMessage>,
  options: {
    readonly id: number;
    readonly format: NativeClipboardFormat;
    readonly bytes: number;
    readonly signal: AbortSignal;
  },
): Promise<Buffer> {
  validateLength(options.format, options.bytes);
  const data = Buffer.allocUnsafe(options.bytes);
  let offset = 0;
  while (true) {
    options.signal.throwIfAborted();
    const message = await nextMessage(iterator);
    if (message.type === "text") {
      const end = parseControl(message);
      expectControl(end, "end", options.id, ["bytes"]);
      if (end.bytes !== options.bytes || offset !== options.bytes)
        throw protocolError();
      validateContent(options.format, data);
      return data;
    }
    const frame = Buffer.from(
      message.data.buffer,
      message.data.byteOffset,
      message.data.byteLength,
    );
    if (
      frame.length <= 8 ||
      frame.length > CHUNK_BYTES + 8 ||
      frame.readUInt32BE(0) !== options.id ||
      frame.readUInt32BE(4) !== offset ||
      offset + frame.length - 8 > data.length
    )
      throw protocolError();
    data.set(frame.subarray(8), offset);
    offset += frame.length - 8;
  }
}
