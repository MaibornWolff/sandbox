const CATEGORY_REFERENCE = Symbol("category-reference");

export const TOOL_SECTIONS = [
  { id: "languages", name: "Languages" },
  { id: "tools", name: "Tools" },
  { id: "ai-agents", name: "AI agents" },
] as const;

export type ToolSectionId = (typeof TOOL_SECTIONS)[number]["id"];

export interface CategoryDefinition<Id extends string = string> {
  readonly id: Id;
  readonly name: string;
  readonly section: ToolSectionId;
  readonly description: string;
  readonly [CATEGORY_REFERENCE]: true;
}

type CategoryInput<Id extends string> = Omit<
  CategoryDefinition<Id>,
  typeof CATEGORY_REFERENCE
>;

export function defineCategory<const Id extends string>(
  category: CategoryInput<Id>,
): CategoryDefinition<Id> {
  return Object.freeze({
    ...category,
    [CATEGORY_REFERENCE]: true as const,
  });
}
