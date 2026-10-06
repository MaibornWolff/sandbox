import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeNativeClipboardService } from "#platform/native-clipboard/__test__/index.js";
import type { NativeClipboardService } from "#platform/native-clipboard/index.js";
import type { ProcessTerminalStreams } from "#platform/terminal/index.js";
import { runSandboxApplicationWithClipboard } from "../production-application.js";

function createFileClipboard(directory: string): NativeClipboardService {
  const native = createFakeNativeClipboardService();
  const refresh = () => {
    const path = join(directory, "format");
    const format = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    if (format !== "text/plain" && format !== "image/png") {
      native.replace();
      return;
    }
    native.replace({ format, data: readFileSync(join(directory, "input")) });
  };
  return {
    async discover(options) {
      refresh();
      return native.discover(options);
    },
    async read(format, options) {
      refresh();
      return native.read(format, options);
    },
    async publish(item, options) {
      await native.publish(item, options);
      writeFileSync(join(directory, "input"), item.data);
      writeFileSync(join(directory, "published-format"), item.format);
    },
    [Symbol.asyncDispose]: () => native[Symbol.asyncDispose](),
  };
}

export function runClipboardTestApplication(options: {
  readonly directory: string;
  readonly argv: readonly string[];
  readonly streams: ProcessTerminalStreams;
}): Promise<number> {
  return runSandboxApplicationWithClipboard(options.argv, options.streams, () =>
    createFileClipboard(options.directory),
  );
}
