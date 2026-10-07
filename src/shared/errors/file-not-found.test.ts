import { describe, expect, test } from "bun:test";
import { isFileNotFoundError } from "./file-not-found.js";

describe("isFileNotFoundError", () => {
  test("recognizes ENOENT errors", () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(isFileNotFoundError(error)).toBe(true);
    expect(isFileNotFoundError({ code: "ENOENT" })).toBe(true);
  });

  test("rejects other errors and values", () => {
    expect(
      isFileNotFoundError(Object.assign(new Error(), { code: "EACCES" })),
    ).toBe(false);
    expect(isFileNotFoundError(new Error("no code"))).toBe(false);
    expect(isFileNotFoundError(null)).toBe(false);
    expect(isFileNotFoundError("ENOENT")).toBe(false);
  });
});
