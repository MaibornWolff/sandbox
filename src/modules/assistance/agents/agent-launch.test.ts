import { describe, expect, test } from "bun:test";
import {
  buildAssistLaunchSpec,
  formatAssistLaunchCommand,
} from "./agent-launch.js";

describe("buildAssistLaunchSpec", () => {
  test("claude with question stays interactive", () => {
    const result = buildAssistLaunchSpec({
      agent: { name: "Claude Code", command: "claude" },
      prompt: "system prompt",
      question: "my question",
    });
    expect(result.cmd).toBe("claude");
    expect(result.args).not.toContain("-p");
    expect(result.args).toContain("my question");
    expect(result.args).toContain("--append-system-prompt");
    expect(result.contextFile).toBeUndefined();
  });

  test("pi without question uses inline prompt mode", () => {
    const result = buildAssistLaunchSpec({
      agent: { name: "Pi", command: "pi" },
      prompt: "system prompt",
    });
    expect(result.cmd).toBe("pi");
    expect(result.args).toEqual(["--append-system-prompt", "system prompt"]);
    expect(result.contextFile).toBeUndefined();
  });

  test("codex with question uses positional prompt and context file", () => {
    const result = buildAssistLaunchSpec({
      agent: { name: "Codex", command: "codex" },
      prompt: "system prompt",
      question: "my question",
    });
    expect(result.cmd).toBe("codex");
    expect(result.args).toHaveLength(1);
    expect(result.args[0]).toContain("my question");
    expect(result.args[0]).toContain("sandbox-assist-context.md");
    expect(result.contextFile?.path).toContain("sandbox-assist-context.md");
    expect(result.contextFile?.content).toBe("system prompt");
  });

  test("opencode with question uses --prompt and context file", () => {
    const result = buildAssistLaunchSpec({
      agent: { name: "OpenCode", command: "opencode" },
      prompt: "system prompt",
      question: "my question",
    });
    expect(result.cmd).toBe("opencode");
    expect(result.args[0]).toBe("--prompt");
    expect(result.args[1]).toContain("my question");
    expect(result.args[1]).toContain("sandbox-assist-context.md");
    expect(result.contextFile?.path).toContain("sandbox-assist-context.md");
    expect(result.contextFile?.content).toBe("system prompt");
  });

  test("context file paths are unique per invocation", () => {
    const first = buildAssistLaunchSpec({
      agent: { name: "OpenCode", command: "opencode" },
      prompt: "system prompt",
      question: "first",
    });
    const second = buildAssistLaunchSpec({
      agent: { name: "OpenCode", command: "opencode" },
      prompt: "system prompt",
      question: "second",
    });
    expect(first.contextFile?.path).not.toBe(second.contextFile?.path);
  });

  test("copilot with question uses -i and context file", () => {
    const result = buildAssistLaunchSpec({
      agent: { name: "GitHub Copilot", command: "copilot" },
      prompt: "system prompt",
      question: "my question",
    });
    expect(result.cmd).toBe("copilot");
    expect(result.args[0]).toBe("-i");
    expect(result.args[1]).toContain("my question");
    expect(result.args[1]).toContain("sandbox-assist-context.md");
    expect(result.contextFile?.path).toContain("sandbox-assist-context.md");
    expect(result.requiresManualStart).toBeUndefined();
  });

  test("copilot without question returns a manual-start spec", () => {
    const result = buildAssistLaunchSpec({
      agent: { name: "GitHub Copilot", command: "copilot" },
      prompt: "system prompt",
    });
    expect(result.cmd).toBe("copilot");
    expect(result.args).toEqual([]);
    expect(result.contextFile?.path).toContain("sandbox-assist-context.md");
    expect(result.requiresManualStart).toBe(true);
  });

  test("unknown agents fall back to positional prompt with context file", () => {
    const result = buildAssistLaunchSpec({
      agent: { name: "custom", command: "custom-agent" },
      prompt: "system prompt",
      question: "my question",
    });
    expect(result.cmd).toBe("custom-agent");
    expect(result.args).toHaveLength(1);
    expect(result.args[0]).toContain("my question");
    expect(result.args[0]).toContain("sandbox-assist-context.md");
    expect(result.contextFile?.content).toBe("system prompt");
  });
});

describe("formatAssistLaunchCommand", () => {
  test("formats command without args", () => {
    expect(formatAssistLaunchCommand({ cmd: "opencode", args: [] })).toBe(
      "opencode",
    );
  });

  test("quotes unsafe args for debug output", () => {
    expect(
      formatAssistLaunchCommand({
        cmd: "pi",
        args: ["--append-system-prompt", "hello world", "what's up"],
      }),
    ).toBe("pi --append-system-prompt 'hello world' 'what'\\''s up'");
  });
});
