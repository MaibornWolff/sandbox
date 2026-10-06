import type { NativeClipboardBackend } from "../types.js";

export function createMemoryBackend() {
  let text = "initial text";
  let image = "";
  let formats = ["UTF8_STRING"];
  const writes: string[] = [];
  const calls: string[] = [];
  const backend: NativeClipboardBackend = {
    async availableFormats() {
      calls.push("formats");
      return [...formats];
    },
    async getText() {
      calls.push("text");
      return text;
    },
    async setText(value) {
      calls.push("setText");
      writes.push(value);
      text = value;
      formats = ["UTF8_STRING"];
    },
    async getImageBase64() {
      calls.push("image");
      return image;
    },
    async setImageBase64(value) {
      calls.push("setImage");
      writes.push(value);
      image = value;
      formats = ["image/png"];
    },
  };
  return {
    backend,
    writes,
    calls,
    offer(next: { formats: string[]; text?: string; image?: string }) {
      formats = next.formats;
      text = next.text ?? "";
      image = next.image ?? "";
    },
  };
}
