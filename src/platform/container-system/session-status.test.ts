import { describe, expect, test } from "bun:test";
import { parseSessionStatus } from "./session-status.js";

const SESSION_ID = "6f1c0d3e-9a4b-4c2d-8e7f-1a2b3c4d5e6f";

function hex(content: string): string {
  return Buffer.from(content).toString("hex") || "-";
}

function sessionLine(marker: string, title = "-"): string {
  return `session 74 1794819735 ${marker} ${title}`;
}

describe("parseSessionStatus", () => {
  test("reads the ready state, the PID, the start time and the title", () => {
    expect(
      parseSessionStatus(
        `ready 1\n${sessionLine("-", hex("node\0/usr/bin/codex\0\0"))}\n`,
      ),
    ).toEqual({
      ready: true,
      sessions: [
        {
          pid: 74,
          startedAt: new Date(1_794_819_735_000),
          id: null,
          command: null,
          title: "node /usr/bin/codex",
        },
      ],
    });
    expect(parseSessionStatus("ready 0\n")).toEqual({
      ready: false,
      sessions: [],
    });
  });

  test.each([
    ["an empty marker from a CLI before session IDs", "", null, null],
    ["a marker with only the session ID", SESSION_ID, SESSION_ID, null],
    [
      "marker v2",
      `${SESSION_ID}\0claude\0--resume\0`,
      SESSION_ID,
      ["claude", "--resume"],
    ],
    ["marker v2 with an empty session ID", "\0claude\0", null, ["claude"]],
    ["marker v2 with an empty argument", `${SESSION_ID}\0\0`, SESSION_ID, [""]],
    [
      "an incomplete marker v2",
      `${SESSION_ID}\0claude\0--res`,
      SESSION_ID,
      null,
    ],
    [
      "a marker larger than 64 KiB",
      `${SESSION_ID}\0claude\0${"x".repeat(64 * 1024)}`,
      SESSION_ID,
      null,
    ],
  ])("decodes %s", (_name, marker, id, command) => {
    const status = parseSessionStatus(`ready 1\n${sessionLine(hex(marker))}\n`);

    expect(status.sessions[0]).toMatchObject({ id, command });
  });

  test.each([
    ["empty output", ""],
    ["an invalid ready state", "ready 2\n"],
    ["a session line before the ready line", `${sessionLine("-")}\nready 1\n`],
  ])("reports a probe failure for %s", (_name, output) => {
    expect(() => parseSessionStatus(output)).toThrow(
      "Session status output has no valid ready line.",
    );
  });

  test.each([
    ["a non-numeric PID", "session pid 1794819735 - -"],
    ["a missing field", "session 74 1794819735 -"],
    ["an invalid marker encoding", "session 74 1794819735 xyz -"],
    ["an unknown line", "warning: unexpected"],
  ])("reports a probe failure for %s", (_name, line) => {
    expect(() => parseSessionStatus(`ready 1\n${line}\n`)).toThrow(
      "Session status has",
    );
  });
});
