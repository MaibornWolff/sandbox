import type { CategoryDefinition } from "./category-definition.js";
import type { ToolDefinition } from "./tool-definition.js";

/** @lintignore Public capability preset contract. */
export interface PresetDefinition<
  Category extends CategoryDefinition = CategoryDefinition,
> {
  readonly category: Category;
  readonly tools: readonly ToolDefinition<Category>[];
}

export function definePreset<
  const Category extends CategoryDefinition,
  Tools extends readonly ToolDefinition<Category>[],
>(
  category: Category,
  tools: Tools,
): PresetDefinition<Category> & { tools: Tools } {
  return { category, tools };
}

function validateDependencies(tools: readonly ToolDefinition[]): void {
  const registeredTools = new Set(tools);
  for (const tool of tools) {
    for (const dependency of tool.requires ?? []) {
      if (!registeredTools.has(dependency)) {
        throw new Error(
          `Tool ${tool.id} requires unregistered tool ${dependency.id}`,
        );
      }
    }
  }

  const visited = new Set<ToolDefinition>();
  const active = new Set<ToolDefinition>();
  const path: ToolDefinition[] = [];

  function visit(tool: ToolDefinition): void {
    if (active.has(tool)) {
      const cycleStart = path.indexOf(tool);
      const cycle = [...path.slice(cycleStart), tool].map((entry) => entry.id);
      throw new Error(`Dependency cycle: ${cycle.join(" -> ")}`);
    }
    if (visited.has(tool)) return;

    active.add(tool);
    path.push(tool);
    for (const dependency of tool.requires ?? []) visit(dependency);
    path.pop();
    active.delete(tool);
    visited.add(tool);
  }

  for (const tool of tools) visit(tool);
}

export function createToolRegistry(
  presets: readonly PresetDefinition[],
): ToolDefinition[] {
  const categoryIds = new Set<string>();
  const toolIds = new Set<string>();
  const tools: ToolDefinition[] = [];

  for (const preset of presets) {
    if (categoryIds.has(preset.category.id)) {
      throw new Error(`Duplicate category ID: ${preset.category.id}`);
    }
    categoryIds.add(preset.category.id);

    for (const tool of preset.tools) {
      if (tool.category !== preset.category) {
        throw new Error(
          `Tool ${tool.id} is assigned to category ${tool.category.id} outside owning preset ${preset.category.id}`,
        );
      }
      if (toolIds.has(tool.id)) {
        throw new Error(`Duplicate tool ID: ${tool.id}`);
      }
      toolIds.add(tool.id);
      tools.push(tool);
    }
  }

  validateDependencies(tools);
  return tools;
}
