import type { NativeClipboardFormat } from "./types.js";

const TEXT: Readonly<Record<string, readonly string[]>> = {
  darwin: [
    "public.utf8-plain-text",
    "public.utf16-plain-text",
    "public.text",
    "NSStringPboardType",
  ],
  win32: ["CF_UNICODETEXT", "CF_TEXT", "UnicodeText", "Text", "13", "1"],
  linux: [
    "UTF8_STRING",
    "STRING",
    "TEXT",
    "text/plain",
    "text/plain;charset=utf-8",
    "text/plain;charset=UTF-8",
  ],
};
const IMAGE: Readonly<Record<string, readonly string[]>> = {
  darwin: ["public.png", "public.tiff", "NSTIFFPboardType"],
  win32: ["PNG", "CF_DIB", "CF_DIBV5", "CF_BITMAP", "8", "17", "2"],
  linux: ["image/png", "image/bmp", "image/tiff", "image/jpeg"],
};

export function mapNativeFormats(
  platform: NodeJS.Platform,
  formats: readonly string[],
): NativeClipboardFormat[] {
  const result: NativeClipboardFormat[] = [];
  if (formats.some((format) => TEXT[platform]?.includes(format)))
    result.push("text/plain");
  if (formats.some((format) => IMAGE[platform]?.includes(format)))
    result.push("image/png");
  return result;
}
