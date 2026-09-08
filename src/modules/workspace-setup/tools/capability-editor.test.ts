import { describe, expect, test } from "bun:test";
import { createTestTerminal } from "#platform/terminal/__test__/index.js";
import { selectTools } from "./tool-selection.js";

async function finishReview(
  terminal: ReturnType<typeof createTestTerminal>,
): Promise<void> {
  await terminal.user.type("G");
  await terminal.user.enter();
  await terminal.waitForText("Review capabilities");
  await terminal.user.enter();
}

describe("capability tree editor", () => {
  test("uses terminal height and restores collapsed groups after search", async () => {
    const terminal = createTestTerminal({ columns: 120, rows: 40 });
    try {
      const answer = terminal.run(() => selectTools());
      await terminal.waitForText("Configure capabilities");
      expect(terminal.screen()).toContain("Rust");
      await terminal.user.enter();
      await terminal.waitForText("+ ○ Languages");

      await terminal.user.type("/nodejs");
      await terminal.waitForText("Node.js + npm");
      await terminal.user.enter();
      await terminal.user.type("c");
      await terminal.waitForText("+ ○ Languages");
      expect(terminal.screen()).not.toContain("Node.js + npm");

      await terminal.user.right();
      await terminal.user.down(2);
      await terminal.user.space();
      await finishReview(terminal);
      expect(await answer).toEqual(["node"]);
    } finally {
      await terminal.dispose();
    }
  });

  test("searches descriptions, URLs, and parent ecosystems in collapsed categories", async () => {
    for (const query of [
      "compact text output",
      "anthropics/agent-browser",
      "browser and documents",
    ]) {
      const terminal = createTestTerminal({ columns: 120 });
      try {
        const answer = terminal.run(() => selectTools());
        await terminal.waitForText("Configure capabilities");
        await terminal.user.type(`/${query}`);
        await terminal.waitForText("Agent Browser");
        await terminal.user.enter();
        await terminal.user.type("c");
        await finishReview(terminal);
        await answer;
      } finally {
        await terminal.dispose();
      }
    }
  });

  test("indents tools below category symbols and shows Continue at both ends", async () => {
    const terminal = createTestTerminal({ columns: 120 });
    try {
      const answer = terminal.run(() => selectTools());
      await terminal.waitForText("Configure capabilities");
      expect(terminal.screen()).toContain("        ○ Node.js + npm");

      await terminal.user.type("/continue");
      await terminal.waitForText("Search: continue");
      const continueScreen = terminal.screen();
      expect(continueScreen.indexOf("[ Continue ]")).not.toBe(
        continueScreen.lastIndexOf("[ Continue ]"),
      );
      expect(terminal.screen()).not.toContain("Review and continue");
      await terminal.user.enter();
      await terminal.user.enter();
      await terminal.waitForText("Review capabilities");
      await terminal.user.enter();
      expect(await answer).toEqual([]);
    } finally {
      await terminal.dispose();
    }
  });

  test("shows direct and automatic dependency reasons in review", async () => {
    const terminal = createTestTerminal({ columns: 120 });
    try {
      const answer = terminal.run(() =>
        selectTools({ preSelectedIds: ["agent-browser"] }),
      );
      await terminal.waitForText("Agent Browser");
      await terminal.user.type("G");
      await terminal.user.enter();
      await terminal.waitForText("Review capabilities");
      expect(terminal.screen()).toContain("Direct selections: Agent Browser");
      expect(terminal.screen()).toContain(
        "Automatic selections: Node.js + npm",
      );
      expect(terminal.screen()).toContain("required by Agent Browser");
      await terminal.user.enter();
      expect(await answer).toEqual(["agent-browser"]);
    } finally {
      await terminal.dispose();
    }
  });

  test("promotes and demotes a required automatic dependency without removing it", async () => {
    const terminal = createTestTerminal({ columns: 120 });
    try {
      const answer = terminal.run(() =>
        selectTools({ preSelectedIds: ["agent-browser"] }),
      );
      await terminal.waitForText("Configure capabilities");
      await terminal.user.type("/chromium.org");
      await terminal.waitForText("Chromium");
      await terminal.user.enter();
      await terminal.user.down(2);
      await terminal.waitForText("◆ Chromium");
      await terminal.user.space();
      await terminal.waitForText("● Chromium");
      await terminal.user.space();
      await terminal.waitForText("◆ Chromium");
      await terminal.user.type("G");
      await terminal.user.enter();
      await terminal.waitForText("Review capabilities");
      await terminal.user.enter();
      expect(await answer).toEqual(["agent-browser"]);
    } finally {
      await terminal.dispose();
    }
  });

  test("supports Vim, section, boundary, and review navigation", async () => {
    const terminal = createTestTerminal({ columns: 120 });
    try {
      const answer = terminal.run(() => selectTools());
      await terminal.waitForText("Configure capabilities");
      await terminal.user.type("l");
      await terminal.user.type("j");
      await terminal.user.type("k");
      await terminal.user.tab();
      await terminal.waitForText("Tools");
      await terminal.user.shiftTab();
      await terminal.user.type("g");
      await terminal.user.type("G");
      await terminal.user.enter();
      await terminal.waitForText("Review capabilities");
      await terminal.user.up();
      await terminal.user.down();
      await terminal.user.enter();
      expect(await answer).toEqual([]);
    } finally {
      await terminal.dispose();
    }
  });

  test("selects a capability group with the keyboard", async () => {
    const terminal = createTestTerminal({ columns: 120 });
    try {
      const answer = terminal.run(() => selectTools());
      await terminal.waitForText("Configure capabilities");
      await terminal.user.down();
      await terminal.user.space();
      await finishReview(terminal);
      expect(await answer).toEqual(["node", "bun", "pnpm"]);
    } finally {
      await terminal.dispose();
    }
  });

  test("centers the active row and separates it from its details", async () => {
    const terminal = createTestTerminal({ columns: 120, rows: 20 });
    try {
      const answer = terminal.run(() => selectTools());
      await terminal.waitForText("Configure capabilities");
      for (let index = 0; index < 8; index++) {
        await terminal.user.down();
      }

      await terminal.waitForText("Java runtime and build tools");
      const lines = terminal.screen().split("\n");
      expect(lines.findIndex((line) => line.includes("┃"))).toBe(4);
      expect(lines[7]).toBe("");

      await finishReview(terminal);
      await answer;
    } finally {
      await terminal.dispose();
    }
  });

  test("keeps a visible OSC 8 documentation URL in the fixed focus panel", async () => {
    const terminal = createTestTerminal({
      columns: 120,
      supportsHyperlinks: true,
    });
    try {
      const answer = terminal.run(() => selectTools());
      await terminal.waitForText("Configure capabilities");
      await terminal.user.down(2);
      await terminal.waitForText("Docs: https://nodejs.org");
      expect(terminal.rawOutput()).toContain(
        "\u001b]8;;https://nodejs.org\u0007",
      );
      await finishReview(terminal);
      await answer;
    } finally {
      await terminal.dispose();
    }
  });
});
