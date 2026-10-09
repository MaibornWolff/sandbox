import { describe, expect, test } from "bun:test";
import { defineCategory } from "./category-definition.js";
import {
  createToolRegistry,
  type PresetDefinition,
} from "./preset-definition.js";
import type { ToolDefinition } from "./tool-definition.js";

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
