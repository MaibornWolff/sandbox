export const NATIVE_CLIPBOARD_FORMATS = ["text/plain", "image/png"] as const;
export type NativeClipboardFormat = (typeof NATIVE_CLIPBOARD_FORMATS)[number];
export const NATIVE_CLIPBOARD_ERROR_CODES = [
  "backend-unavailable",
  "missing-format",
  "backend-failure",
  "busy",
  "cancelled",
  "publication-uncertain",
  "disposed",
] as const;
export type NativeClipboardErrorCode =
  (typeof NATIVE_CLIPBOARD_ERROR_CODES)[number];

export function isNativeClipboardFormat(
  value: unknown,
): value is NativeClipboardFormat {
  return NATIVE_CLIPBOARD_FORMATS.some((format) => format === value);
}

export class NativeClipboardError extends Error {
  constructor(readonly code: NativeClipboardErrorCode) {
    super(`Native clipboard operation failed: ${code}.`);
    this.name = "NativeClipboardError";
  }
}

export interface NativeClipboardOptions {
  readonly signal?: AbortSignal;
}
export interface NativeClipboardItem {
  readonly format: NativeClipboardFormat;
  readonly data: Uint8Array;
}
export interface NativeClipboardService extends AsyncDisposable {
  discover(
    options?: NativeClipboardOptions,
  ): Promise<readonly NativeClipboardFormat[]>;
  read(
    format: NativeClipboardFormat,
    options?: NativeClipboardOptions,
  ): Promise<Buffer>;
  publish(
    item: NativeClipboardItem,
    options?: NativeClipboardOptions,
  ): Promise<void>;
}

export interface NativeClipboardBackend {
  availableFormats(): string[] | Promise<string[]>;
  getText(): Promise<string>;
  setText(text: string): Promise<void>;
  getImageBase64(): Promise<string>;
  setImageBase64(image: string): Promise<void>;
}
