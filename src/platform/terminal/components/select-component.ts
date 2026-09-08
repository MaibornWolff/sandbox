import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import {
  PromptCancellationError,
  type TuiPromptContext,
} from "../tui-prompt.js";
import { SelectionListModel } from "./selection-list-model.js";
import {
  type NormalizedChoice,
  normalizeChoices,
  type SelectConfig,
} from "./selection-types.js";

function selectable<T>(choice: NormalizedChoice<T>): boolean {
  return !choice.disabled;
}

export class SelectComponent<T> implements Component {
  private readonly selection: SelectionListModel<NormalizedChoice<T>>;

  constructor(
    private readonly config: SelectConfig<T>,
    private readonly context: TuiPromptContext<T>,
  ) {
    const choices = normalizeChoices(config.choices);
    this.selection = new SelectionListModel(choices, {
      isSelectable: selectable,
      loop: config.loop !== false,
    });
    const configured = choices.findIndex(
      (choice) => choice.value === config.default && selectable(choice),
    );
    if (configured !== -1) this.selection.select(configured);
  }

  render(width: number): string[] {
    const entries = this.selection.page(
      this.selection.entries(),
      this.config.pageSize ?? 7,
    );
    const lines = [
      `? ${this.config.message}`,
      ...entries.map((entry) => {
        const active = entry.originalIndex === this.selection.activeIndex;
        const cursor = active ? chalk.cyan("┃") : " ";
        const name = active ? chalk.cyan(entry.item.name) : entry.item.name;
        return `${cursor} ${name}`;
      }),
      "",
      ...(this.selection.active?.description
        ? [chalk.dim(this.selection.active.description)]
        : []),
      chalk.dim("↑↓/jk navigate  enter select  esc cancel"),
    ];
    return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
      this.context.fail(new PromptCancellationError());
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const active = this.selection.active;
      if (active) this.context.done(active.value);
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.selection.move(this.selection.entries(), -1);
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.selection.move(this.selection.entries(), 1);
    }
    this.context.tui.requestRender();
  }

  invalidate(): void {}
}
