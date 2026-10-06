import { describe, expect, test } from "bun:test";
import {
  formatErrorAssistHint,
  shouldShowErrorAssistHint,
} from "./error-assistance-hint.js";

describe("assist-hint", () => {
  test("formats the error assist hint with the recovery guidance", () => {
    const hint = formatErrorAssistHint();
    expect(hint).toContain("Need help fixing this?");
    expect(hint).toContain("sandbox assist");
    expect(hint).toContain("start an agent with your sandbox context");
    expect(hint).toContain(
      "Paste the error above into the chat and say what you were trying to do.",
    );
  });

  test("suppresses the error hint for assist", () => {
    expect(shouldShowErrorAssistHint(["assist"])).toBe(false);
  });

  test("suppresses the error hint for verbose assist", () => {
    expect(shouldShowErrorAssistHint(["--verbose", "assist"])).toBe(false);
  });

  test.each(["-c", "--clipboard"])(
    "does not consume a value for removed option %s",
    (flag) => {
      expect(shouldShowErrorAssistHint([flag, "disabled", "assist"])).toBe(
        true,
      );
    },
  );

  test("shows the error hint for non-assist commands", () => {
    expect(shouldShowErrorAssistHint(["doctor"])).toBe(true);
  });
});
