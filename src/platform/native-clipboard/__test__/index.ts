export { createMemoryBackend } from "./memory-backend.js";

import {
  NativeClipboardError,
  type NativeClipboardFormat,
  type NativeClipboardItem,
  type NativeClipboardService,
} from "../types.js";

export function createFakeNativeClipboardService(
  initial?: NativeClipboardItem,
): NativeClipboardService & {
  readonly publications: readonly NativeClipboardItem[];
  replace(item?: NativeClipboardItem): void;
} {
  let item = initial;
  let disposed = false;
  const publications: NativeClipboardItem[] = [];
  function available(signal?: AbortSignal): void {
    if (disposed) throw new NativeClipboardError("disposed");
    if (signal?.aborted) throw new NativeClipboardError("cancelled");
  }
  return {
    publications,
    replace(next) {
      item = next && { format: next.format, data: Buffer.from(next.data) };
    },
    async discover(options) {
      available(options?.signal);
      return item ? [item.format] : [];
    },
    async read(format: NativeClipboardFormat, options) {
      available(options?.signal);
      if (!item || item.format !== format)
        throw new NativeClipboardError("missing-format");
      return Buffer.from(item.data);
    },
    async publish(next, options) {
      available(options?.signal);
      item = { format: next.format, data: Buffer.from(next.data) };
      publications.push(item);
    },
    async [Symbol.asyncDispose]() {
      disposed = true;
      item = undefined;
    },
  };
}
