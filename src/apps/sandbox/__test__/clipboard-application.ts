import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  NativeClipboardError,
  NativeClipboardFormat,
  NativeClipboardService,
} from "#platform/native-clipboard/index.js";

export function createFileClipboard(
  directory: string,
  ClipboardError: typeof NativeClipboardError,
): NativeClipboardService {
  const currentFormat = (): NativeClipboardFormat | undefined => {
    const path = join(directory, "format");
    const format = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    if (format === "text/plain" || format === "image/png") return format;
  };
  return {
    async discover() {
      const format = currentFormat();
      return format ? [format] : [];
    },
    async read(format) {
      if (currentFormat() !== format)
        throw new ClipboardError("missing-format");
      return readFileSync(join(directory, "input"));
    },
    async publish(item) {
      writeFileSync(join(directory, "input"), item.data);
      writeFileSync(join(directory, "published-format"), item.format);
    },
    async [Symbol.asyncDispose]() {},
  };
}
