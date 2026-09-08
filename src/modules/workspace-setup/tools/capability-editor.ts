import {
  decodeKittyPrintable,
  Key,
  matchesKey,
  parseKey,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { getTerminal, runTuiPrompt } from "#platform/terminal/index.js";
import { TOOL_SECTIONS, type ToolSectionId } from "./category-definition.js";
import {
  CapabilityEditorComponent,
  type CapabilityEditorController,
} from "./components/capability-editor-component.js";
import type { ToolDefinition } from "./tool-definition.js";
import { resolveTools, setDirectSelection } from "./tool-resolution.js";

const TOP_CONTINUE_ID = "action:continue-top";
const BOTTOM_CONTINUE_ID = "action:continue-bottom";
const MIN_PAGE_SIZE = 3;
const MAX_PAGE_SIZE = 30;
const NON_TREE_ROWS = 14;

type SearchMode = "inactive" | "editing" | "locked";
type RowKind = "section" | "category" | "tool" | "review";
type SelectionState = "available" | "direct" | "automatic" | "partial";

interface FullKeyEvent {
  readonly name?: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
}

function printableInput(data: string): string | undefined {
  if (data.length === 1 && data >= " ") return data;
  return decodeKittyPrintable(data);
}

function keyEvent(data: string): FullKeyEvent {
  const parsed = parseKey(data);
  const name = [
    Key.escape,
    Key.enter,
    Key.backspace,
    Key.up,
    Key.down,
    Key.left,
    Key.right,
    Key.home,
    Key.end,
    Key.tab,
    Key.space,
  ].find((key) => matchesKey(data, key));
  return {
    name,
    sequence: printableInput(data),
    ctrl: parsed?.includes("ctrl+") ?? false,
    shift: parsed?.includes("shift+") ?? false,
  };
}

function isBackspaceKey(key: FullKeyEvent): boolean {
  return key.name === Key.backspace;
}

function isDownKey(key: FullKeyEvent, keybindings: readonly string[]): boolean {
  return (
    key.name === Key.down ||
    (keybindings.includes("vim") && key.sequence === "j")
  );
}

function isEnterKey(key: FullKeyEvent): boolean {
  return key.name === Key.enter;
}

function isSpaceKey(key: FullKeyEvent): boolean {
  return key.name === Key.space || key.sequence === " ";
}

function isUpKey(key: FullKeyEvent, keybindings: readonly string[]): boolean {
  return (
    key.name === Key.up || (keybindings.includes("vim") && key.sequence === "k")
  );
}

interface CapabilityCategory {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly section: ToolSectionId;
  readonly tools: readonly ToolDefinition[];
}

interface CapabilitySection {
  readonly id: ToolSectionId;
  readonly name: string;
  readonly categories: readonly CapabilityCategory[];
}

interface CapabilityRow {
  readonly id: string;
  readonly kind: RowKind;
  readonly level: number;
  readonly sectionId?: ToolSectionId;
  readonly category?: CapabilityCategory;
  readonly tool?: ToolDefinition;
}

interface CapabilityTreeModel {
  readonly sections: readonly CapabilitySection[];
  readonly rowsById: ReadonlyMap<string, CapabilityRow>;
}

interface CapabilityEditorOptions {
  readonly registry: readonly ToolDefinition[];
  readonly preSelectedIds: readonly string[];
}

interface PromptConfig extends CapabilityEditorOptions {
  readonly model: CapabilityTreeModel;
  readonly pageSize: number;
  readonly hyperlink: (url: string) => string;
}

interface EditorState {
  readonly directIds: readonly string[];
  readonly expanded: ReadonlySet<string>;
  readonly expansionBeforeSearch: ReadonlySet<string> | undefined;
  readonly activeId: string;
  readonly searchMode: SearchMode;
  readonly searchText: string;
  readonly view: "tree" | "review";
  readonly error: string | undefined;
}

function createModel(registry: readonly ToolDefinition[]): CapabilityTreeModel {
  const categories = new Map<string, CapabilityCategory>();
  for (const tool of registry) {
    const existing = categories.get(tool.category.id);
    if (existing) {
      (existing.tools as ToolDefinition[]).push(tool);
      continue;
    }
    categories.set(tool.category.id, {
      id: tool.category.id,
      name: tool.category.name,
      description: tool.category.description,
      section: tool.category.section,
      tools: [tool],
    });
  }
  const sections = TOOL_SECTIONS.map((section) => ({
    ...section,
    categories: [...categories.values()].filter(
      (category) => category.section === section.id,
    ),
  })).filter((section) => section.categories.length > 0);
  const rows = sections.flatMap((section) => [
    {
      id: `section:${section.id}`,
      kind: "section" as const,
      level: 0,
      sectionId: section.id,
    },
    ...section.categories.flatMap((category) => [
      {
        id: `category:${category.id}`,
        kind: "category" as const,
        level: 1,
        sectionId: section.id,
        category,
      },
      ...category.tools.map((tool) => ({
        id: `tool:${tool.id}`,
        kind: "tool" as const,
        level: 2,
        sectionId: section.id,
        category,
        tool,
      })),
    ]),
  ]);
  const continueRows: CapabilityRow[] = [
    { id: TOP_CONTINUE_ID, kind: "review", level: 0 },
    { id: BOTTOM_CONTINUE_ID, kind: "review", level: 0 },
  ];
  return {
    sections,
    rowsById: new Map([...rows, ...continueRows].map((row) => [row.id, row])),
  };
}

function searchableValues(
  row: CapabilityRow,
  model: CapabilityTreeModel,
): readonly string[] {
  if (row.kind === "tool" && row.tool && row.category) {
    const section = model.sections.find(
      (candidate) => candidate.id === row.sectionId,
    );
    return [
      row.tool.name,
      row.tool.description,
      row.tool.url ?? "",
      ...(row.tool.aliases ?? []),
      row.category.id,
      row.category.name,
      row.category.description,
      section?.name ?? "",
    ];
  }
  if (row.kind === "category" && row.category) {
    return [row.category.id, row.category.name, row.category.description];
  }
  if (row.kind === "section") {
    return [
      row.sectionId ?? "",
      model.sections.find((section) => section.id === row.sectionId)?.name ??
        "",
    ];
  }
  return ["review", "continue"];
}

/** Returns all matching rows and their ancestors, including collapsed tools. */
function searchCapabilityRows(
  model: CapabilityTreeModel,
  query: string,
): ReadonlySet<string> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return new Set(model.rowsById.keys());
  const matches = new Set<string>();
  for (const row of model.rowsById.values()) {
    if (
      searchableValues(row, model).some((value) =>
        value.toLowerCase().includes(normalized),
      )
    ) {
      matches.add(row.id);
      if (row.sectionId) matches.add(`section:${row.sectionId}`);
      if (row.category) matches.add(`category:${row.category.id}`);
    }
  }
  return matches;
}

function matchingToolRows(
  category: CapabilityCategory,
  model: CapabilityTreeModel,
  matches: ReadonlySet<string>,
  searching: boolean,
): CapabilityRow[] {
  return category.tools
    .map((tool) => model.rowsById.get(`tool:${tool.id}`) as CapabilityRow)
    .filter((row) => !searching || matches.has(row.id));
}

function matchingCategoryRows(
  section: CapabilitySection,
  model: CapabilityTreeModel,
  expanded: ReadonlySet<string>,
  matches: ReadonlySet<string>,
  searching: boolean,
): CapabilityRow[] {
  return section.categories.flatMap((category) => {
    const categoryId = `category:${category.id}`;
    if (searching && !matches.has(categoryId)) return [];
    const categoryRow = model.rowsById.get(categoryId) as CapabilityRow;
    if (!searching && !expanded.has(categoryId)) return [categoryRow];
    return [
      categoryRow,
      ...matchingToolRows(category, model, matches, searching),
    ];
  });
}

function visibleRows(
  model: CapabilityTreeModel,
  expanded: ReadonlySet<string>,
  query: string,
): CapabilityRow[] {
  const searching = query.length > 0;
  const matches = searchCapabilityRows(model, query);
  const rows = model.sections.flatMap((section) => {
    const sectionId = `section:${section.id}`;
    if (searching && !matches.has(sectionId)) return [];
    const sectionRow = model.rowsById.get(sectionId) as CapabilityRow;
    if (!searching && !expanded.has(sectionId)) return [sectionRow];
    return [
      sectionRow,
      ...matchingCategoryRows(section, model, expanded, matches, searching),
    ];
  });
  const topContinue = model.rowsById.get(TOP_CONTINUE_ID) as CapabilityRow;
  const bottomContinue = model.rowsById.get(
    BOTTOM_CONTINUE_ID,
  ) as CapabilityRow;
  return [
    ...(!searching || matches.has(TOP_CONTINUE_ID) ? [topContinue] : []),
    ...rows,
    bottomContinue,
  ];
}

function descendants(
  row: CapabilityRow,
  model: CapabilityTreeModel,
): ToolDefinition[] {
  if (row.tool) return [row.tool];
  if (row.category) return [...row.category.tools];
  if (row.sectionId) {
    return (
      model.sections.find((section) => section.id === row.sectionId)
        ?.categories ?? []
    ).flatMap((category) => category.tools);
  }
  return [];
}

function selectionState(
  row: CapabilityRow,
  state: EditorState,
  model: CapabilityTreeModel,
): {
  readonly state: SelectionState;
  readonly selected: number;
  readonly total: number;
} {
  const tools = descendants(row, model);
  const resolved = resolveTools(
    state.directIds,
    model.sections.flatMap((section) =>
      section.categories.flatMap((category) => category.tools),
    ),
  );
  const direct = new Set(resolved.directSelections);
  const selected = new Set(resolved.dependencyClosure);
  const selectedCount = tools.filter((tool) => selected.has(tool)).length;
  const directCount = tools.filter((tool) => direct.has(tool)).length;
  let visual: SelectionState = "available";
  if (selectedCount > 0 && selectedCount < tools.length) visual = "partial";
  else if (selectedCount === tools.length && directCount === tools.length)
    visual = "direct";
  else if (selectedCount === tools.length && tools.length > 0)
    visual = "automatic";
  return { state: visual, selected: selectedCount, total: tools.length };
}

function visualSymbol(state: SelectionState): string {
  switch (state) {
    case "direct":
      return chalk.green("●");
    case "automatic":
      return chalk.cyan("◆");
    case "partial":
      return chalk.yellow("◐");
    case "available":
      return "○";
  }
}

function rowLabel(
  row: CapabilityRow,
  state: EditorState,
  model: CapabilityTreeModel,
): string {
  if (row.kind === "review") return "[ Continue ]";
  const selection = selectionState(row, state, model);
  const expanded = state.expanded.has(row.id) || state.searchText.length > 0;
  const expander = row.kind === "tool" ? "" : expanded ? "− " : "+ ";
  const name =
    row.tool?.name ??
    row.category?.name ??
    model.sections.find((section) => section.id === row.sectionId)?.name ??
    "";
  const detail =
    row.kind === "tool"
      ? dependencyDetail(row.tool as ToolDefinition, state, model)
      : row.kind === "category"
        ? `${selection.selected} of ${selection.total} selected`
        : `${selection.selected} selected`;
  const indentLevel = row.level + (row.kind === "tool" ? 1 : 0);
  return `${"  ".repeat(indentLevel)}${expander}${visualSymbol(selection.state)} ${name}${detail ? chalk.dim(`  ${detail}`) : ""}`;
}

function dependencyDetail(
  tool: ToolDefinition,
  state: EditorState,
  model: CapabilityTreeModel,
): string {
  const registry = model.sections.flatMap((section) =>
    section.categories.flatMap((category) => category.tools),
  );
  const reasons =
    resolveTools(state.directIds, registry).dependencyReasons.get(tool) ?? [];
  return reasons.length > 0
    ? `required by ${reasons.map((reason) => reason.name).join(", ")}`
    : "";
}

function focusedDescription(
  row: CapabilityRow | undefined,
  model: CapabilityTreeModel,
  hyperlink: (url: string) => string,
): string[] {
  if (!row || row.kind === "review") {
    return [
      "Continue",
      "Check direct and automatic selections before continuing.",
      " ",
    ];
  }
  const section = model.sections.find(
    (candidate) => candidate.id === row.sectionId,
  );
  const name = row.tool?.name ?? row.category?.name ?? section?.name ?? "";
  const description =
    row.tool?.description ??
    row.category?.description ??
    `${name} capabilities`;
  return [
    chalk.bold(name),
    description,
    row.tool?.url ? `Docs: ${hyperlink(row.tool.url)}` : " ",
  ];
}

function pageRows(
  rows: readonly CapabilityRow[],
  activeId: string,
  pageSize: number,
): readonly CapabilityRow[] {
  const active = Math.max(
    0,
    rows.findIndex((row) => row.id === activeId),
  );
  const start = Math.max(
    0,
    Math.min(active - Math.floor(pageSize / 2), rows.length - pageSize),
  );
  return rows.slice(start, start + pageSize);
}

function renderTree(state: EditorState, config: PromptConfig): string {
  const rows = visibleRows(config.model, state.expanded, state.searchText);
  const activeId = rows.some((row) => row.id === state.activeId)
    ? state.activeId
    : (rows[0]?.id ?? TOP_CONTINUE_ID);
  const page = pageRows(rows, activeId, config.pageSize);
  const tree = page
    .map((row) => {
      const label = rowLabel(row, state, config.model);
      return row.id === activeId ? chalk.cyan(`┃ ${label}`) : `  ${label}`;
    })
    .join("\n");
  const search =
    state.searchMode === "inactive"
      ? ""
      : `${state.searchMode === "editing" ? chalk.cyan("Search:") : chalk.dim("Search:")} ${state.searchText}${state.searchMode === "editing" ? "▏" : ""}`;
  const panel = focusedDescription(
    config.model.rowsById.get(activeId),
    config.model,
    config.hyperlink,
  ).join("\n");
  const help = chalk.dim(
    "↑↓/jk move  ←→/hl expand  space select  tab section  / search  g/G ends",
  );
  return [
    "Configure capabilities",
    ...(search ? [search] : []),
    tree,
    "",
    panel,
    ...(state.error ? [chalk.yellow(state.error)] : []),
    help,
  ].join("\n");
}

function reviewLines(state: EditorState, config: PromptConfig): string[] {
  const resolved = resolveTools(state.directIds, config.registry);
  const direct =
    resolved.directSelections.map((tool) => tool.name).join(", ") || "None";
  const automatic =
    resolved.automaticSelections
      .map(
        (tool) =>
          `${tool.name} (${dependencyDetail(tool, state, config.model)})`,
      )
      .join(", ") || "None";
  return [
    "Review capabilities",
    `${chalk.green("●")} Direct selections: ${direct}`,
    `${chalk.cyan("◆")} Automatic selections: ${automatic}`,
    "",
    state.activeId === "review:back" ? chalk.cyan("┃ [ Back ]") : "  [ Back ]",
    state.activeId === "review:continue"
      ? chalk.cyan("┃ [ Continue ]")
      : "  [ Continue ]",
    "",
    chalk.dim("Enter continue  Esc back"),
  ];
}

function renderReview(state: EditorState, config: PromptConfig): string {
  return reviewLines(state, config).join("\n");
}

function moveFocus(
  state: EditorState,
  rows: readonly CapabilityRow[],
  offset: number,
): EditorState {
  const current = Math.max(
    0,
    rows.findIndex((row) => row.id === state.activeId),
  );
  const next = Math.max(0, Math.min(rows.length - 1, current + offset));
  return {
    ...state,
    activeId: rows[next]?.id ?? TOP_CONTINUE_ID,
    error: undefined,
  };
}

function toggleExpansion(
  state: EditorState,
  row: CapabilityRow,
  expanded: boolean,
): EditorState {
  if (
    row.kind === "tool" ||
    row.kind === "review" ||
    state.searchMode !== "inactive"
  )
    return state;
  const next = new Set(state.expanded);
  if (expanded) next.add(row.id);
  else next.delete(row.id);
  return { ...state, expanded: next, error: undefined };
}

function toggleSelection(
  state: EditorState,
  row: CapabilityRow,
  config: PromptConfig,
): EditorState {
  const tools = descendants(row, config.model);
  if (tools.length === 0) return state;
  const resolved = resolveTools(state.directIds, config.registry);
  const selected = new Set(resolved.dependencyClosure);
  const direct = new Set(resolved.directSelections);
  const allSelected = tools.every((tool) => selected.has(tool));
  let next = [...state.directIds];
  if (row.kind === "tool" && row.tool && !direct.has(row.tool)) {
    next = setDirectSelection(next, row.tool.id, true, config.registry);
  } else if (allSelected) {
    const removing = new Set(tools.map((tool) => tool.id));
    next = next.filter((id) => !removing.has(id));
  } else {
    for (const tool of tools) {
      if (!selected.has(tool))
        next = setDirectSelection(next, tool.id, true, config.registry);
    }
  }
  return { ...state, directIds: next, error: undefined };
}

function activateRow(
  state: EditorState,
  row: CapabilityRow,
  config: PromptConfig,
): EditorState {
  if (row.kind === "review") {
    return {
      ...state,
      view: "review",
      activeId: "review:continue",
      error: undefined,
    };
  }
  if (row.kind === "tool") return toggleSelection(state, row, config);
  return toggleExpansion(state, row, !state.expanded.has(row.id));
}

function closeSearch(state: EditorState): EditorState {
  return {
    ...state,
    expanded: state.expansionBeforeSearch ?? state.expanded,
    expansionBeforeSearch: undefined,
    searchMode: "inactive",
    searchText: "",
    error: undefined,
  };
}

function handleSearchKey(
  state: EditorState,
  key: FullKeyEvent,
): EditorState | undefined {
  if (key.name === "escape") return closeSearch(state);
  if (isEnterKey(key)) return { ...state, searchMode: "locked" };
  if (isBackspaceKey(key))
    return { ...state, searchText: state.searchText.slice(0, -1) };
  const character = key.sequence;
  if (character && character.length === 1 && character >= " " && !key.ctrl) {
    return { ...state, searchText: state.searchText + character };
  }
  return undefined;
}

function moveToSection(
  state: EditorState,
  config: PromptConfig,
  reverse: boolean,
): EditorState {
  const sectionIds = config.model.sections.map(
    (section) => `section:${section.id}`,
  );
  const row = config.model.rowsById.get(state.activeId);
  const current = row?.sectionId
    ? sectionIds.indexOf(`section:${row.sectionId}`)
    : sectionIds.length;
  const next = reverse
    ? Math.max(0, current - 1)
    : Math.min(sectionIds.length, current + 1);
  return { ...state, activeId: sectionIds[next] ?? BOTTOM_CONTINUE_ID };
}

function handleEditingMode(
  state: EditorState,
  key: FullKeyEvent,
  config: PromptConfig,
): EditorState {
  const searchRows = visibleRows(
    config.model,
    state.expanded,
    state.searchText,
  );
  if (isUpKey(key, [])) return moveFocus(state, searchRows, -1);
  if (isDownKey(key, [])) return moveFocus(state, searchRows, 1);
  const next = handleSearchKey(state, key) ?? state;
  const nextRows = visibleRows(config.model, next.expanded, next.searchText);
  return nextRows.some((row) => row.id === next.activeId)
    ? next
    : { ...next, activeId: nextRows[0]?.id ?? TOP_CONTINUE_ID };
}

function handleSearchModeChange(
  state: EditorState,
  key: FullKeyEvent,
): EditorState | undefined {
  const closing =
    state.searchMode === "locked" &&
    (key.name === "escape" || key.sequence === "c");
  if (closing) return closeSearch(state);
  if (key.sequence !== "/" || key.ctrl) return undefined;
  return {
    ...state,
    expansionBeforeSearch:
      state.expansionBeforeSearch ?? new Set(state.expanded),
    searchMode: "editing",
    searchText: state.searchMode === "inactive" ? "" : state.searchText,
  };
}

function handleFocusKey(
  state: EditorState,
  key: FullKeyEvent,
  rows: readonly CapabilityRow[],
  config: PromptConfig,
): EditorState | undefined {
  if (isUpKey(key, ["vim"])) return moveFocus(state, rows, -1);
  if (isDownKey(key, ["vim"])) return moveFocus(state, rows, 1);
  if (key.name === "home" || key.sequence === "g") {
    return { ...state, activeId: rows[0]?.id ?? TOP_CONTINUE_ID };
  }
  if (key.name === "end" || key.sequence === "G") {
    return { ...state, activeId: BOTTOM_CONTINUE_ID };
  }
  if (key.name === "tab")
    return moveToSection(state, config, key.shift === true);
  return undefined;
}

function handleRowKey(
  state: EditorState,
  key: FullKeyEvent,
  row: CapabilityRow,
  config: PromptConfig,
): EditorState {
  if (key.name === "left" || key.sequence === "h") {
    return toggleExpansion(state, row, false);
  }
  if (key.name === "right" || key.sequence === "l") {
    return toggleExpansion(state, row, true);
  }
  if (isSpaceKey(key)) return toggleSelection(state, row, config);
  if (isEnterKey(key)) return activateRow(state, row, config);
  return state;
}

function handleTreeKey(
  state: EditorState,
  key: FullKeyEvent,
  config: PromptConfig,
): EditorState {
  if (state.searchMode === "editing")
    return handleEditingMode(state, key, config);
  const searchChange = handleSearchModeChange(state, key);
  if (searchChange) return searchChange;
  const rows = visibleRows(config.model, state.expanded, state.searchText);
  const focusChange = handleFocusKey(state, key, rows, config);
  if (focusChange) return focusChange;
  const row =
    rows.find((candidate) => candidate.id === state.activeId) ?? rows[0];
  return row ? handleRowKey(state, key, row, config) : state;
}

function handleReviewKey(
  state: EditorState,
  key: FullKeyEvent,
): EditorState | "done" | undefined {
  if (
    key.name === "escape" ||
    (isEnterKey(key) && state.activeId === "review:back")
  ) {
    return { ...state, view: "tree", activeId: BOTTOM_CONTINUE_ID };
  }
  if (isUpKey(key, ["vim"]) || isDownKey(key, ["vim"]) || key.name === "tab") {
    return {
      ...state,
      activeId:
        state.activeId === "review:continue"
          ? "review:back"
          : "review:continue",
    };
  }
  return isEnterKey(key) && state.activeId === "review:continue"
    ? "done"
    : undefined;
}

function initialState(config: PromptConfig): EditorState {
  const expanded = new Set(
    [...config.model.rowsById.values()]
      .filter((row) => row.kind === "section" || row.kind === "category")
      .map((row) => row.id),
  );
  return {
    directIds: config.preSelectedIds,
    expanded,
    expansionBeforeSearch: undefined,
    activeId: config.model.sections[0]
      ? `section:${config.model.sections[0].id}`
      : TOP_CONTINUE_ID,
    searchMode: "inactive",
    searchText: "",
    view: "tree",
    error: undefined,
  };
}

class CapabilityEditorStateController implements CapabilityEditorController {
  private state: EditorState;

  constructor(private readonly config: PromptConfig) {
    this.state = initialState(config);
  }

  render(width: number): string[] {
    const output =
      this.state.view === "review"
        ? renderReview(this.state, this.config)
        : renderTree(this.state, this.config);
    return output
      .split("\n")
      .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
  }

  handleInput(data: string): readonly string[] | undefined {
    const key = keyEvent(data);
    if (this.state.view === "tree") {
      this.state = handleTreeKey(this.state, key, this.config);
      return undefined;
    }
    const reviewChange = handleReviewKey(this.state, key);
    if (reviewChange === "done") return this.state.directIds;
    if (reviewChange) this.state = reviewChange;
    return undefined;
  }
}

/** Opens the searchable capability tree and returns direct capability IDs. */
export function editCapabilities(
  options: CapabilityEditorOptions,
): Promise<string[]> {
  const terminal = getTerminal();
  const model = createModel(options.registry);
  const config: PromptConfig = {
    ...options,
    model,
    pageSize: Math.min(
      MAX_PAGE_SIZE,
      Math.max(MIN_PAGE_SIZE, terminal.rows - NON_TREE_ROWS),
    ),
    hyperlink: (url) =>
      terminal.supportsHyperlinks
        ? `\u001b]8;;${url}\u0007${url}\u001b]8;;\u0007`
        : url,
  };
  return runTuiPrompt(
    (context) =>
      new CapabilityEditorComponent(
        new CapabilityEditorStateController(config),
        context,
      ),
  );
}
