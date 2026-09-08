import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { detectAgent, resolveAgent } from "./agent-detection.js";

function withAvailableAgents<T>(
  commands: readonly string[],
  operation: () => T,
): T {
  const root = createTestDir("assist-agent-detection");
  try {
    for (const command of commands) {
      const executable = path.join(root, command);
      fs.writeFileSync(executable, "fixture");
      fs.chmodSync(executable, 0o755);
    }
    return runWithTestLogger(operation, { variables: { PATH: root } });
  } finally {
    cleanupTestDir(root);
  }
}

describe("detectAgent", () => {
  test("returns null when no agent is found", () => {
    expect(withAvailableAgents([], () => detectAgent())).toBeNull();
  });

  test("returns first available agent in priority order", () => {
    const result = withAvailableAgents(["pi", "copilot"], () => detectAgent());
    expect(result).toEqual({ name: "GitHub Copilot", command: "copilot" });
  });

  test("prefers codex over opencode when both are available", () => {
    const result = withAvailableAgents(["codex", "opencode"], () =>
      detectAgent(),
    );
    expect(result).toEqual({ name: "Codex", command: "codex" });
  });

  test("returns claude when it is available first", () => {
    const result = withAvailableAgents(["claude"], () => detectAgent());
    expect(result).toEqual({ name: "Claude Code", command: "claude" });
  });
});

describe("resolveAgent", () => {
  test("returns explicit agent when specified", () => {
    expect(resolveAgent("custom-agent")).toEqual({
      command: "custom-agent",
      name: "custom-agent",
    });
  });

  test("auto-detects agent when no explicit agent given", () => {
    const result = withAvailableAgents(["opencode"], () => resolveAgent());
    expect(result).toEqual({ name: "OpenCode", command: "opencode" });
  });

  test("throws when no agent found and none specified", () => {
    expect(() => withAvailableAgents([], () => resolveAgent())).toThrow(
      "No AI agent found",
    );
  });
});
