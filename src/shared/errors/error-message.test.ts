import { describe, expect, test } from "bun:test";
import { getErrorMessage } from "./error-message.js";

describe("getErrorMessage", () => {
  test("returns the message of an Error", () => {
    expect(getErrorMessage(new Error("disk full"))).toBe("disk full");
  });

  test("returns the string form of other thrown values", () => {
    expect(getErrorMessage("plain text")).toBe("plain text");
    expect(getErrorMessage(42)).toBe("42");
    expect(getErrorMessage(undefined)).toBe("undefined");
  });
});
