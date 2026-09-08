import { describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { createTestTerminal } from "./__test__/index.js";
import { promptConfirmation, promptSelectionConfirmation } from "./prompt.js";

describe("selection confirmation", () => {
  test("renders the colored selection inline and supports arrow navigation", async () => {
    const terminal = createTestTerminal();
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => terminal.dispose());
    const answer = terminal.run(() =>
      promptSelectionConfirmation({ message: "Continue?", default: true }),
    );

    await terminal.waitForText("? Continue? (Y)es/(n)o");
    await terminal.user.right();
    await terminal.waitForText("? Continue? (y)es/(N)o");
    await terminal.user.enter();

    expect(await answer).toBe(false);
  });

  test.each([
    ["lowercase yes", "y", true],
    ["uppercase yes", "Y", true],
    ["lowercase no", "n", false],
    ["uppercase no", "N", false],
  ] as const)("accepts %s immediately", async (_name, input, expected) => {
    const terminal = createTestTerminal();
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => terminal.dispose());
    const answer = terminal.run(() =>
      promptSelectionConfirmation({ message: "Continue?", default: true }),
    );
    await terminal.waitForText("Continue?");

    await terminal.user.type(input);

    expect(await Promise.race([answer, delay(50, "timed out")])).toBe(expected);
  });

  test("restores terminal mode when the terminal aborts", async () => {
    const terminal = createTestTerminal();
    const answer = terminal.run(() =>
      promptSelectionConfirmation({ message: "Continue?", default: true }),
    );
    const cancellation = answer.catch((error: unknown) => error);
    await terminal.waitForText("Continue?");
    terminal.abort();

    expect(await cancellation).toBeInstanceOf(Error);
    expect(terminal.rawMode()).toBe(false);
    await terminal.dispose();
  });
});

describe("prompt confirmation", () => {
  test("renders No as the inline default selection", async () => {
    const terminal = createTestTerminal();
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => terminal.dispose());
    const answer = terminal.run(() => promptConfirmation("Continue? "));

    await terminal.waitForText("? Continue? (y)es/(N)o");
    await terminal.user.enter();

    expect(await answer).toBe(false);
  });

  test("treats Ctrl-C as a declined confirmation", async () => {
    const terminal = createTestTerminal();
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => terminal.dispose());
    const answer = terminal.run(() => promptConfirmation("Continue? "));
    await terminal.waitForText("Continue?");

    await terminal.user.chord("c", { ctrl: true });

    expect(await Promise.race([answer, delay(50, "timed out")])).toBe(false);
  });

  test("rejects and closes when the scoped signal aborts", async () => {
    const terminal = createTestTerminal();
    const answer = terminal.run(() => promptConfirmation("Continue? "));
    const cancellation = answer.catch((error: unknown) => error);
    await terminal.waitForText("Continue?");

    terminal.abort();

    expect(await cancellation).toBeInstanceOf(Error);
    await terminal.dispose();
  });

  test("rejects immediately when the scoped signal is already aborted", async () => {
    const terminal = createTestTerminal();
    terminal.abort();

    const answer = terminal.run(() => promptConfirmation("Continue? "));
    const result = await Promise.race([
      answer.catch((error: unknown) => error),
      delay(50, "timed out"),
    ]);

    expect(result).toBeInstanceOf(Error);
    await terminal.dispose();
  });
});
