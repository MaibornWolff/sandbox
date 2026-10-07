import { describe, expect, test } from "bun:test";
import { createClipboardTestImage } from "./__test__/index.js";
import { validatePng } from "./png.js";

describe("validatePng", () => {
  test("accepts a complete PNG", () => {
    expect(() => validatePng(createClipboardTestImage())).not.toThrow();
  });

  test("rejects truncated data, broken checksums and random bytes", () => {
    const png = createClipboardTestImage();
    const changed = Buffer.from(png);
    changed.writeUInt32BE(0, changed.length - 20);
    expect(() => validatePng(png.subarray(0, 40))).toThrow();
    expect(() => validatePng(changed)).toThrow();
    expect(() => validatePng(Buffer.alloc(100))).toThrow();
  });

  test("rejects excessive dimensions", () => {
    const png = createClipboardTestImage();
    png.writeUInt32BE(16_385, 16);
    expect(() => validatePng(png)).toThrow();
  });
});
