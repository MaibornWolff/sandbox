import { editCapabilities } from "./capability-editor.js";
import type { ToolSectionId } from "./category-definition.js";
import type { ToolDefinition } from "./tool-definition.js";
import { TOOL_REGISTRY } from "./tool-registry.js";

/** @testonly Groups tools by fixed display section in registry order. */
export function groupToolsByCategory(
  tools: ToolDefinition[],
): Map<ToolSectionId, ToolDefinition[]> {
  const groups = new Map<ToolSectionId, ToolDefinition[]>();
  for (const tool of tools) {
    const existing = groups.get(tool.category.section);
    if (existing) existing.push(tool);
    else groups.set(tool.category.section, [tool]);
  }
  return groups;
}

/** @testonly Filters legacy conditional capability declarations. */
export function filterVisibleTools(
  tools: ToolDefinition[],
  selectedIds: string[],
): ToolDefinition[] {
  return tools.filter(
    (tool) =>
      !tool.showWhen ||
      tool.showWhen.length === 0 ||
      tool.showWhen.some((id) => selectedIds.includes(id)),
  );
}

interface SelectToolsOptions {
  registry?: ToolDefinition[];
  excludeCategories?: ToolSectionId[];
  preSelectedIds?: string[];
  projectLevel?: boolean;
}

/** @testonly Filters restored direct selections to editor capabilities. */
export function filterPreSelectedIds(
  preSelectedIds: string[],
  registry: ToolDefinition[],
  excludeCategories: Set<string>,
): string[] {
  const ids = new Set(registry.map((tool) => tool.id));
  return preSelectedIds.filter((id) => {
    const tool = registry.find((candidate) => candidate.id === id);
    return (
      ids.has(id) &&
      tool !== undefined &&
      !excludeCategories.has(tool.category.section)
    );
  });
}

/** Opens one capability tree and returns direct selections in interaction order. */
export async function selectTools(
  options: SelectToolsOptions = {},
): Promise<string[]> {
  const fullRegistry = options.registry ?? TOOL_REGISTRY;
  const excluded = new Set(options.excludeCategories ?? []);
  const registry = fullRegistry.filter(
    (tool) =>
      (options.projectLevel || !tool.projectOnly) &&
      !excluded.has(tool.category.section),
  );
  return editCapabilities({
    registry,
    preSelectedIds: filterPreSelectedIds(
      options.preSelectedIds ?? [],
      registry,
      excluded,
    ),
  });
}

/** @testonly Resolves known capabilities in caller-provided order. */
export function getToolsById(
  ids: string[],
  registry: ToolDefinition[] = TOOL_REGISTRY,
): ToolDefinition[] {
  return ids
    .map((id) => registry.find((tool) => tool.id === id))
    .filter((tool): tool is ToolDefinition => tool !== undefined);
}
