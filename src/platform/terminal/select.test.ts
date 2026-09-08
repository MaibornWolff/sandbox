import { describe, expect, test } from "bun:test";
import { createTestTerminal, type TestTerminal } from "./__test__/index.js";
import { selectCheckbox, selectOne } from "./select.js";

function runCheckbox(
  terminal: TestTerminal,
  choices: Array<{ value: string; name: string }>,
  pageSize = 7,
) {
  return terminal.run(() =>
    selectCheckbox({
      message: "Select tools:",
      choices,
      pageSize,
      loop: false,
    }),
  );
}

const choices = [
  { value: "alpha", name: "Alpha" },
  { value: "beta", name: "Beta" },
  { value: "gamma", name: "Gamma" },
];

describe("searchable checkbox terminal behavior", () => {
  test("renders, selects, and submits through TTY streams", async () => {
    const terminal = createTestTerminal();
    try {
      const answer = runCheckbox(terminal, choices);
      await terminal.waitForText("Select tools:");
      expect(terminal.screen()).toContain("Alpha");
      await terminal.user.space();
      await terminal.user.enter();

      expect(await answer).toEqual(["alpha"]);
      expect(terminal.output()).toContain("Alpha");
    } finally {
      await terminal.dispose();
    }
  });

  test("keeps the active description visible", async () => {
    const terminal = createTestTerminal();
    try {
      const answer = terminal.run(() =>
        selectCheckbox({
          message: "Select tools:",
          choices: [
            {
              value: "alpha",
              name: "Alpha",
              description: "Docs: https://example.com/alpha",
            },
            { value: "beta", name: "Beta" },
          ],
          loop: false,
        }),
      );
      await terminal.waitForText("https://example.com/alpha");
      expect(terminal.screen()).toContain("https://example.com/alpha");
      await terminal.user.enter();
      expect(await answer).toEqual([]);
    } finally {
      await terminal.dispose();
    }
  });

  test("filters, locks the filter, and selects the visible result", async () => {
    const terminal = createTestTerminal();
    try {
      const answer = runCheckbox(terminal, choices);
      await terminal.waitForText("Select tools:");
      await terminal.user.type("/bet");
      await terminal.waitForText("Filter: bet");
      expect(terminal.screen()).not.toContain("Alpha");
      await terminal.user.enter();
      await terminal.user.space();
      await terminal.user.enter();

      expect(await answer).toEqual(["beta"]);
    } finally {
      await terminal.dispose();
    }
  });

  test("navigates with arrows and permits an empty submission", async () => {
    const navigatedTerminal = createTestTerminal();
    try {
      const navigated = runCheckbox(navigatedTerminal, choices);
      await navigatedTerminal.waitForText("Select tools:");
      await navigatedTerminal.user.down();
      await navigatedTerminal.user.space();
      await navigatedTerminal.user.enter();
      expect(await navigated).toEqual(["beta"]);
    } finally {
      await navigatedTerminal.dispose();
    }

    const emptyTerminal = createTestTerminal();
    try {
      const empty = runCheckbox(emptyTerminal, choices);
      await emptyTerminal.waitForText("Select tools:");
      await emptyTerminal.user.enter();
      expect(await empty).toEqual([]);
    } finally {
      await emptyTerminal.dispose();
    }
  });

  test("Escape clears an active filter", async () => {
    const terminal = createTestTerminal();
    try {
      const answer = runCheckbox(terminal, choices);
      await terminal.waitForText("Select tools:");
      await terminal.user.type("/bet");
      await terminal.waitForText("Filter: bet");
      await terminal.user.escape();
      await terminal.waitForText("Alpha");
      await terminal.user.enter();
      expect(await answer).toEqual([]);
    } finally {
      await terminal.dispose();
    }
  });

  test("rejects on Ctrl-C and restores terminal mode", async () => {
    const terminal = createTestTerminal();
    try {
      const answer = runCheckbox(terminal, choices);
      await terminal.waitForText("Select tools:");
      const cancellation = answer.catch((error: unknown) => error);
      await terminal.user.chord("c", { ctrl: true });
      expect(await cancellation).toBeInstanceOf(Error);
      expect(terminal.rawMode()).toBe(false);
    } finally {
      await terminal.dispose();
    }
  });

  test("renders pagination and supports selecting beyond the first page", async () => {
    const terminal = createTestTerminal({ rows: 8 });
    const pagedChoices = Array.from({ length: 8 }, (_, index) => ({
      value: `value-${index + 1}`,
      name: `Choice ${index + 1}`,
    }));
    try {
      const answer = runCheckbox(terminal, pagedChoices, 3);
      await terminal.waitForText("Choice 1");
      await terminal.user.down(4);
      await terminal.waitForText("Choice 5");
      await terminal.user.space();
      await terminal.user.enter();
      expect(await answer).toEqual(["value-5"]);
    } finally {
      await terminal.dispose();
    }
  });

  test("reassembles fragmented terminal input", async () => {
    const terminal = createTestTerminal();
    try {
      const answer = terminal.run(() =>
        selectOne({ message: "Choose target:", choices }),
      );
      await terminal.waitForText("Choose target:");
      await terminal.user.inputChunks("\u001b", "[B");
      await terminal.user.enter();
      expect(await answer).toBe("beta");
    } finally {
      await terminal.dispose();
    }
  });

  test("drives select prompts through the same terminal context", async () => {
    const terminal = createTestTerminal();
    try {
      const answer = terminal.run(() =>
        selectOne({
          message: "Choose target:",
          choices: [
            { value: "global", name: "Global" },
            { value: "project", name: "Project" },
          ],
        }),
      );
      await terminal.waitForText("Choose target:");
      await terminal.user.type("j");
      await terminal.user.enter();
      expect(await answer).toBe("project");
    } finally {
      await terminal.dispose();
    }
  });
});
