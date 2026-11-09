import { describe, expect, test } from "bun:test";
import { hardenHostCommand } from "./command-hardening.js";

describe("hardenHostCommand", () => {
  test("points git hooks at the Windows null device", () => {
    const hardened = hardenHostCommand(["git", "status"], {}, "win32");
    expect(hardened.args).toEqual([
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=NUL",
      "status",
    ]);
  });

  test("points git hooks at /dev/null elsewhere", () => {
    const hardened = hardenHostCommand(["git", "status"], {}, "darwin");
    expect(hardened.args).toContain("core.hooksPath=/dev/null");
  });

  test("leaves other commands unchanged apart from the lookup guard", () => {
    const hardened = hardenHostCommand(
      ["bun", "run", "x"],
      { A: "1" },
      "linux",
    );
    expect(hardened.command).toBe("bun");
    expect(hardened.args).toEqual(["run", "x"]);
    expect(hardened.env).toEqual({
      A: "1",
      NoDefaultCurrentDirectoryInExePath: "1",
    });
  });
});
