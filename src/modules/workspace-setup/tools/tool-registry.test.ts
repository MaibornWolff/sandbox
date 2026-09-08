import { describe, expect, test } from "bun:test";
import { AGENT_CONFIGS } from "../agent-config-catalog.js";
import { defineCategory, TOOL_SECTIONS } from "./category-definition.js";
import {
  createToolRegistry,
  type PresetDefinition,
} from "./preset-definition.js";
import { PRESET_REGISTRY } from "./presets/index.js";
import type { ToolDefinition } from "./tool-definition.js";
import { TOOL_REGISTRY } from "./tool-registry.js";

const MIGRATED_TOOL_IDS = [
  "node",
  "bun",
  "java",
  "go",
  "rust",
  "dotnet",
  "php",
  "claude",
  "copilot",
  "codex",
  "opencode",
  "pi",
  "pnpm",
  "composer",
  "ast-grep",
  "delta",
  "hunk",
  "sem",
  "rtk",
  "neovim",
  "uv",
  "just",
  "gradle",
  "maven",
  "dotnet-tools",
  "gh",
  "glab",
  "terraform",
  "kubectl",
  "chromium",
  "libreoffice",
  "agent-browser",
  "devbox",
  "mise-env",
] as const;

function createTestCategory(id: string) {
  return defineCategory({
    id,
    name: id,
    section: "tools",
    description: `${id} category`,
  });
}

function createTestTool(
  id: string,
  category: ReturnType<typeof createTestCategory>,
  requires: readonly ToolDefinition[] = [],
): ToolDefinition {
  return {
    id,
    name: id,
    description: `${id} tool`,
    category,
    requires,
  };
}

describe("capability catalog", () => {
  test("preserves migrated capabilities and adds Python", () => {
    const ids = TOOL_REGISTRY.map((tool) => tool.id);

    expect(MIGRATED_TOOL_IDS.every((id) => ids.includes(id))).toBe(true);
    expect(ids.filter((id) => id === "python")).toEqual(["python"]);
  });

  test("uses fixed section, preset, and declaration order", () => {
    expect(TOOL_SECTIONS.map((section) => section.name)).toEqual([
      "Languages",
      "Tools",
      "AI agents",
    ]);
    expect(PRESET_REGISTRY.map((preset) => preset.category.id)).toEqual([
      "javascript",
      "python",
      "java",
      "go",
      "rust",
      "dotnet",
      "php",
      "developer-tools",
      "platform-tools",
      "browser-documents",
      "ai-agents",
    ]);
    expect(
      PRESET_REGISTRY.flatMap((preset) => [...preset.tools]).map(
        (tool) => tool.id,
      ),
    ).toEqual(TOOL_REGISTRY.map((tool) => tool.id));
    expect(
      TOOL_REGISTRY.filter((tool) => tool.category.id === "javascript").map(
        (tool) => tool.id,
      ),
    ).toEqual(["node", "bun", "pnpm"]);
  });

  test("declares broad JavaScript and Python user defaults", () => {
    expect(
      TOOL_REGISTRY.filter((tool) => tool.defaultForUserInit).map(
        (tool) => tool.id,
      ),
    ).toEqual(["node", "bun", "pnpm", "python", "uv"]);
  });

  test("keeps user and project detector lists explicit", () => {
    expect(
      TOOL_REGISTRY.every(
        (tool) =>
          tool.detect !== undefined &&
          Array.isArray(tool.detect.duringUserInit) &&
          Array.isArray(tool.detect.duringProjectInit),
      ),
    ).toBe(true);
    expect(
      TOOL_REGISTRY.flatMap(
        (tool) => tool.detect?.duringProjectInit ?? [],
      ).every((detector) => detector.kind === "path"),
    ).toBe(true);
  });

  test("keeps detection independent from build-context copying", () => {
    const php = TOOL_REGISTRY.find((tool) => tool.id === "php");
    const miseEnvironment = TOOL_REGISTRY.find(
      (tool) => tool.id === "mise-env",
    );

    expect(php?.detect?.duringProjectInit).toHaveLength(1);
    expect(php?.buildContextFiles).toBeUndefined();
    expect(miseEnvironment?.detect?.duringProjectInit).toHaveLength(4);
    expect(miseEnvironment?.buildContextFiles).toHaveLength(4);
  });

  test("keeps each AI agent linked to the separate configuration catalog", () => {
    const configIds = new Set(AGENT_CONFIGS.map((config) => config.name));
    const agents = TOOL_REGISTRY.filter(
      (tool) => tool.category.section === "ai-agents",
    );

    expect(agents.map((agent) => agent.agentConfigId)).toEqual([
      "Claude Code",
      "Copilot",
      "Codex",
      "OpenCode",
      "Pi",
    ]);
    expect(
      agents.every(
        (agent) =>
          agent.agentConfigId !== undefined &&
          configIds.has(agent.agentConfigId),
      ),
    ).toBe(true);
  });
});

describe("createToolRegistry", () => {
  test("rejects duplicate category IDs", () => {
    const first = createTestCategory("duplicate");
    const second = createTestCategory("duplicate");

    expect(() =>
      createToolRegistry([
        { category: first, tools: [createTestTool("one", first)] },
        { category: second, tools: [createTestTool("two", second)] },
      ]),
    ).toThrow("Duplicate category ID: duplicate");
  });

  test("rejects duplicate tool IDs", () => {
    const first = createTestCategory("first");
    const second = createTestCategory("second");

    expect(() =>
      createToolRegistry([
        { category: first, tools: [createTestTool("duplicate", first)] },
        { category: second, tools: [createTestTool("duplicate", second)] },
      ]),
    ).toThrow("Duplicate tool ID: duplicate");
  });

  test("rejects a tool assigned outside its owning preset", () => {
    const owner = createTestCategory("owner");
    const other = createTestCategory("other");
    const invalidPreset: PresetDefinition = {
      category: owner,
      tools: [createTestTool("misplaced", other)],
    };

    expect(() => createToolRegistry([invalidPreset])).toThrow(
      "Tool misplaced is assigned to category other outside owning preset owner",
    );
  });

  test("rejects a dependency reference to an unregistered tool", () => {
    const category = createTestCategory("owner");
    const missing = createTestTool("missing", category);
    const dependent = createTestTool("dependent", category, [missing]);

    expect(() =>
      createToolRegistry([{ category, tools: [dependent] }]),
    ).toThrow("Tool dependent requires unregistered tool missing");
  });

  test("rejects dependency cycles with the complete cycle path", () => {
    const category = createTestCategory("owner");
    const first = createTestTool("first", category);
    const second = createTestTool("second", category, [first]);
    Object.assign(first, { requires: [second] });

    expect(() =>
      createToolRegistry([{ category, tools: [first, second] }]),
    ).toThrow("Dependency cycle: first -> second -> first");
  });
});
