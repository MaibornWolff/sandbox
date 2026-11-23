import { describe, expect, test } from "bun:test";
import { stripAnsi } from "#test/utils.js";
import { formatProjectMountAccess } from "./trust-prompt.js";

describe("project mount access display", () => {
  test("explains that approval covers all project settings when no mounts are requested", () => {
    const output = stripAnsi(formatProjectMountAccess([]));
    expect(output).toContain(
      "No additional host mounts requested by this project.",
    );
    expect(output).toContain(
      "Trust also approves the other settings in .sandbox.",
    );
  });

  test("shows Windows drive paths without splitting the drive colon", () => {
    const output = stripAnsi(
      formatProjectMountAccess(["D:/shared docs:/reference:ro"]),
    );
    expect(output).toContain('READ ONLY  "D:/shared docs" → "/reference"');
  });

  test("shows read-only access for modes that do not enable runtime writes", () => {
    const output = stripAnsi(
      formatProjectMountAccess(["/data/demo:/reference:readonly"]),
    );
    expect(output).toContain('READ ONLY  "/data/demo" → "/reference"');
    expect(output).not.toContain("READ WRITE");
  });

  test("escapes terminal controls and line breaks in both mount paths", () => {
    const output = stripAnsi(
      formatProjectMountAccess([
        "/data/\u001b[2J\nreference:/dest/\u009b\u202e\n:rw",
      ]),
    );
    expect(output).toContain(
      'READ WRITE  "/data/\\u001b[2J\\nreference" → "/dest/\\u009b\\u202e\\n"',
    );
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u009b");
    expect(output).not.toContain("\u202e");
  });
});
