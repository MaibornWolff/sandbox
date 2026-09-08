import { describe, expect, it } from "bun:test";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  buildConfirmationMessage,
  shouldPromptForConfirmation,
} from "./clean-command.js";

describe("shouldPromptForConfirmation", () => {
  it("prompts only for data deletion without force", () => {
    expect(shouldPromptForConfirmation({ data: true, force: false })).toBe(
      true,
    );
    expect(shouldPromptForConfirmation({ data: true, force: true })).toBe(
      false,
    );
    expect(shouldPromptForConfirmation({ data: false })).toBe(false);
    expect(shouldPromptForConfirmation({})).toBe(false);
  });
});

describe("buildConfirmationMessage", () => {
  it("includes the scoped project data path for data deletion", async () => {
    const root = createTestDir("clean-confirmation");
    try {
      const { result } = await runInHostTestScope({ root }, () =>
        buildConfirmationMessage({ data: true }),
      );
      expect(result).toContain("containers");
      expect(result).toContain("volumes");
      expect(result).toContain("persistent data");
      expect(result).toMatch(/[/\\]sandbox[/\\][a-z0-9-]+/);
      expect(result).not.toMatch(/[/\\]sandbox[/\\]default/);
    } finally {
      cleanupTestDir(root);
    }
  });

  it("mentions only containers without data deletion", async () => {
    const root = createTestDir("clean-confirmation");
    try {
      const { result } = await runInHostTestScope({ root }, () =>
        buildConfirmationMessage({ data: false }),
      );
      expect(result).toContain("containers");
      expect(result).not.toContain("volumes");
      expect(result).not.toContain("persistent data");
    } finally {
      cleanupTestDir(root);
    }
  });
});
