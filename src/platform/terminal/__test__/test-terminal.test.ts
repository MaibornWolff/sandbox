import { describe, expect, test } from "bun:test";
import { createTestTerminal } from "./index.js";

describe("test terminal", () => {
  test("emits text and explicit keyboard byte sequences", async () => {
    const terminal = createTestTerminal();
    const bytes: Buffer[] = [];
    terminal.io.input.on("data", (chunk) => bytes.push(Buffer.from(chunk)));

    await terminal.user.type("abc");
    await terminal.user.enter();
    await terminal.user.space();
    await terminal.user.up();
    await terminal.user.down();
    await terminal.user.left();
    await terminal.user.right();
    await terminal.user.escape();
    await terminal.user.tab();
    await terminal.user.shiftTab();
    await terminal.user.backspace();
    await terminal.user.chord("c", { ctrl: true });

    expect(Buffer.concat(bytes).toString("hex")).toBe(
      Buffer.from(
        "abc\r \u001b[A\u001b[B\u001b[D\u001b[C\u001b\t\u001b[Z\u007f\u0003",
      ).toString("hex"),
    );
    await terminal.dispose();
  });

  test("waits for text written after observation begins", async () => {
    const terminal = createTestTerminal();
    const waiting = terminal.waitForText("later output");

    terminal.io.stdout.write("later output");

    await expect(waiting).resolves.toBeUndefined();
    await terminal.dispose();
  });

  test("interprets ANSI screen replacement while preserving output history", async () => {
    const terminal = createTestTerminal({ columns: 40, rows: 8 });

    terminal.io.stdout.write("old screen");
    await terminal.waitForText("old screen");
    terminal.io.stdout.write("\u001b[2J\u001b[Hnew screen");
    await terminal.waitForText("new screen");

    expect(terminal.screen()).toContain("new screen");
    expect(terminal.screen()).not.toContain("old screen");
    expect(terminal.output()).toContain("old screen");
    expect(terminal.output()).toContain("new screen");
    await terminal.dispose();
  });

  test("reports the visible screen when a public text wait times out", async () => {
    const terminal = createTestTerminal({ timeoutMs: 20 });
    terminal.io.stdout.write("available text");
    await terminal.waitForText("available text");

    await expect(terminal.waitForText("missing text")).rejects.toThrow(
      'Timed out waiting for terminal text "missing text".\nCurrent screen:\navailable text',
    );
    await terminal.dispose();
  });

  test("aborts input and clears raw mode during disposal", async () => {
    const terminal = createTestTerminal();
    terminal.io.input.setRawMode?.(true);

    await terminal.dispose();

    expect(terminal.io.signal.aborted).toBe(true);
    expect(terminal.rawMode()).toBe(false);
  });
});
