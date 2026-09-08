import type { ToolDefinition } from "./tool-definition.js";
import { TOOL_REGISTRY } from "./tool-registry.js";

/** @lintignore Owner-local capability selection model. */
export interface ResolvedTools {
  directSelections: ToolDefinition[];
  automaticSelections: ToolDefinition[];
  dependencyReasons: ReadonlyMap<ToolDefinition, readonly ToolDefinition[]>;
  dependencyClosure: ToolDefinition[];
}

function getRegisteredDirectSelections(
  directIds: readonly string[],
  registry: readonly ToolDefinition[],
): ToolDefinition[] {
  const toolsById = new Map(registry.map((tool) => [tool.id, tool]));
  return [...new Set(directIds)]
    .map((id) => toolsById.get(id))
    .filter((tool): tool is ToolDefinition => tool !== undefined);
}

/** Resolves direct selections and their complete dependency closure. */
export function resolveTools(
  directIds: readonly string[],
  registry: readonly ToolDefinition[] = TOOL_REGISTRY,
): ResolvedTools {
  const directSelections = getRegisteredDirectSelections(directIds, registry);
  const directSet = new Set(directSelections);
  const closureSet = new Set<ToolDefinition>();
  const dependencyReasons = new Map<ToolDefinition, ToolDefinition[]>();

  function collect(tool: ToolDefinition): void {
    if (closureSet.has(tool)) return;
    closureSet.add(tool);

    for (const dependency of tool.requires ?? []) {
      const reasons = dependencyReasons.get(dependency) ?? [];
      if (!reasons.includes(tool)) reasons.push(tool);
      dependencyReasons.set(dependency, reasons);
      collect(dependency);
    }
  }

  for (const tool of directSelections) collect(tool);

  const dependencyClosure = registry.filter((tool) => closureSet.has(tool));
  const automaticSelections = dependencyClosure.filter(
    (tool) => !directSet.has(tool),
  );

  return {
    directSelections,
    automaticSelections,
    dependencyReasons,
    dependencyClosure,
  };
}

/**
 * @lintignore Owner-local capability selection transition API.
 * Selecting an automatic dependency promotes it to direct. Clearing a direct
 * dependency can leave it automatic.
 */
export function setDirectSelection(
  directIds: readonly string[],
  toolId: string,
  selected: boolean,
  registry: readonly ToolDefinition[] = TOOL_REGISTRY,
): string[] {
  const resolved = resolveTools(directIds, registry);
  const tool = registry.find((candidate) => candidate.id === toolId);
  if (!tool) throw new Error(`Unknown tool ID: ${toolId}`);

  if (selected) {
    return resolved.directSelections.includes(tool)
      ? resolved.directSelections.map((selection) => selection.id)
      : [...resolved.directSelections.map((selection) => selection.id), toolId];
  }

  if (!resolved.directSelections.includes(tool)) {
    const requiringTools = resolved.dependencyReasons.get(tool) ?? [];
    if (requiringTools.length > 0) {
      throw new Error(
        `Cannot remove required tool ${tool.name}: required by ${requiringTools.map((dependency) => dependency.name).join(", ")}`,
      );
    }
    return resolved.directSelections.map((selection) => selection.id);
  }

  return resolved.directSelections
    .filter((selection) => selection !== tool)
    .map((selection) => selection.id);
}

/** @testonly Returns capabilities that directly require the given tool. */
export function getDependents(
  toolId: string,
  directIds: readonly string[],
  registry: readonly ToolDefinition[] = TOOL_REGISTRY,
): string[] {
  const tool = registry.find((candidate) => candidate.id === toolId);
  if (!tool) return [];
  return (
    resolveTools(directIds, registry).dependencyReasons.get(tool) ?? []
  ).map((dependent) => dependent.name);
}
