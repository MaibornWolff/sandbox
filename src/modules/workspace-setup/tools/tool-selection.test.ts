import { describe, expect, test } from "bun:test";
import { TOOL_REGISTRY } from "./tool-registry.js";
import {
  filterPreSelectedIds,
  filterVisibleTools,
  getToolsById,
  groupToolsByCategory,
} from "./tool-selection.js";

describe("groupToolsByCategory", () => {
  test("handles empty array", () => {
    const groups = groupToolsByCategory([]);
    expect(groups.size).toBe(0);
  });
});

describe("getToolsById", () => {
  test("ignores unknown IDs", () => {
    const tools = getToolsById(["node", "unknown-tool"]);

    expect(tools.length).toBe(1);
    expect(tools[0]?.id).toBe("node");
  });

  test("handles empty array", () => {
    const tools = getToolsById([]);
    expect(tools.length).toBe(0);
  });
});

describe("preSelectedIds filtering", () => {
  test("valid preSelectedId from registry is kept", () => {
    const result = filterPreSelectedIds(["node"], TOOL_REGISTRY, new Set());
    expect(result).toContain("node");
  });

  test("invalid preSelectedId not in registry is filtered out", () => {
    const result = filterPreSelectedIds(
      ["node", "nonexistent-tool"],
      TOOL_REGISTRY,
      new Set(),
    );
    expect(result).toContain("node");
    expect(result).not.toContain("nonexistent-tool");
  });

  test("preSelectedId from excluded category is filtered out", () => {
    const result = filterPreSelectedIds(
      ["claude"],
      TOOL_REGISTRY,
      new Set(["ai-agents"]),
    );
    expect(result).not.toContain("claude");
  });

  test("preSelectedId from non-excluded category is kept", () => {
    const result = filterPreSelectedIds(
      ["node"],
      TOOL_REGISTRY,
      new Set(["ai-agents"]),
    );
    expect(result).toContain("node");
  });
});

describe("filterVisibleTools", () => {
  test("shows tools without showWhen", () => {
    const tools = filterVisibleTools(TOOL_REGISTRY, []);

    // node has no showWhen, should be visible
    expect(tools.some((t) => t.id === "node")).toBe(true);
    // uv has no showWhen, should be visible
    expect(tools.some((t) => t.id === "uv")).toBe(true);
  });

  test("hides tools when showWhen condition not met", () => {
    const tools = filterVisibleTools(TOOL_REGISTRY, []);

    // gradle has showWhen: ["java"], should be hidden when java not selected
    expect(tools.some((t) => t.id === "gradle")).toBe(false);
    expect(tools.some((t) => t.id === "maven")).toBe(false);
  });

  test("shows tools when showWhen condition is met", () => {
    const tools = filterVisibleTools(TOOL_REGISTRY, ["java"]);

    // gradle and maven should be visible when java is selected
    expect(tools.some((t) => t.id === "gradle")).toBe(true);
    expect(tools.some((t) => t.id === "maven")).toBe(true);
  });

  test("filters out selected tools when showWhen condition is no longer met", () => {
    // Scenario: user selected gradle, but java is not in selectedIds
    // This could happen if user deselects java after selecting gradle
    const tools = filterVisibleTools(TOOL_REGISTRY, ["gradle"]);

    // gradle has showWhen: ["java"], so it should be hidden
    // even though it's in the selectedIds array
    expect(tools.some((t) => t.id === "gradle")).toBe(false);

    // Tools without showWhen should still be visible
    expect(tools.some((t) => t.id === "node")).toBe(true);
  });
});
