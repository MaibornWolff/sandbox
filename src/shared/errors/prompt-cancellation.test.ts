import { describe, expect, test } from "bun:test";
import { isPromptCancellation } from "./prompt-cancellation.js";

describe("isPromptCancellation", () => {
  test("recognizes application prompt cancellations", () => {
    const error = new Error("The interactive prompt was cancelled.");
    error.name = "PromptCancellationError";
    expect(isPromptCancellation(error)).toBe(true);
  });

  test("rejects unrelated errors and values", () => {
    expect(isPromptCancellation(new Error("failed"))).toBe(false);
    expect(isPromptCancellation("cancelled")).toBe(false);
  });
});
