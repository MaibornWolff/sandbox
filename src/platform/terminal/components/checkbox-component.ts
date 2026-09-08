import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import {
  PromptCancellationError,
  type TuiPromptContext,
} from "../tui-prompt.js";
import {
  type CheckboxEntry,
  CheckboxModel,
  type CheckboxSearchMode,
  type CheckboxView,
} from "./checkbox-model.js";
import type { CheckboxConfig } from "./selection-types.js";

function renderChoice<T>(entry: CheckboxEntry<T>, activeIndex: number): string {
  const choice = entry.item;
  const cursor = entry.originalIndex === activeIndex ? chalk.cyan("┃") : " ";
  if (choice.disabled) {
    const reason =
      typeof choice.disabled === "string" ? choice.disabled : "(disabled)";
    return `${cursor} ${chalk.dim(`- ${choice.name} ${reason}`)}`;
  }
  const marker = choice.checked ? chalk.green("●") : "○";
  return `${cursor} ${marker} ${choice.name}`;
}

function renderSearch(mode: CheckboxSearchMode, text: string): string[] {
  if (mode === "inactive") return [];
  const label =
    mode === "editing" ? chalk.cyan("Filter:") : chalk.dim("Filter:");
  return [`${label} ${text}${mode === "editing" ? "▏" : ""}`];
}

function renderStatus<T>(view: CheckboxView<T>): string[] {
  const lines: string[] = [];
  if (view.active?.description) lines.push(chalk.cyan(view.active.description));
  if (view.error) lines.push(chalk.yellow(view.error));
  return lines;
}

function renderHelp(mode: CheckboxSearchMode): string {
  return chalk.dim(
    mode === "editing"
      ? "↑↓ navigate  space select  esc clear  enter lock"
      : "↑↓/jk navigate  space select  / filter  enter submit",
  );
}

function renderChoices<T>(
  entries: readonly CheckboxEntry<T>[],
  activeIndex: number,
): string[] {
  if (entries.length === 0) return [chalk.yellow("No matching choices")];
  return entries.map((entry) => renderChoice(entry, activeIndex));
}

export class CheckboxComponent<T> implements Component {
  private readonly model: CheckboxModel<T>;

  constructor(
    private readonly config: CheckboxConfig<T>,
    private readonly context: TuiPromptContext<T[]>,
  ) {
    this.model = new CheckboxModel(config);
  }

  render(width: number): string[] {
    const view = this.model.view();
    const lines = [
      `? ${this.config.message}`,
      ...renderSearch(view.searchMode, view.searchText),
      ...renderChoices(view.entries, view.activeIndex),
      "",
      ...renderStatus(view),
      renderHelp(view.searchMode),
    ];
    return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  handleInput(data: string): void {
    const effect = this.model.handleInput(data);
    if (effect?.type === "cancel") {
      this.context.fail(new PromptCancellationError());
      return;
    }
    if (effect?.type === "complete") {
      this.context.done([...effect.values]);
      return;
    }
    this.context.tui.requestRender();
  }

  invalidate(): void {}
}
