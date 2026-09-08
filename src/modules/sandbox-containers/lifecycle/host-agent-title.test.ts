import { describe, expect, test } from "bun:test";
import { resolveHostAgentTitle } from "./host-agent-title.js";

describe("resolveHostAgentTitle", () => {
  test("uses the command basename as title", () => {
    expect(resolveHostAgentTitle(["pi"])).toBe("pi");
    expect(resolveHostAgentTitle(["ls"])).toBe("ls");
    expect(resolveHostAgentTitle(["/usr/local/bin/codex"])).toBe("codex");
  });

  test("ignores empty commands", () => {
    expect(resolveHostAgentTitle([])).toBeUndefined();
  });

  test("only reads the executable", () => {
    expect(resolveHostAgentTitle(["env", "FOO=1", "pi"])).toBe("env");
    expect(resolveHostAgentTitle(["npm", "run", "pi"])).toBe("npm");
  });
});
