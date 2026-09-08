import { decodeKittyPrintable, Key, matchesKey } from "@earendil-works/pi-tui";
import {
  type SelectionEntry,
  SelectionListModel,
} from "./selection-list-model.js";
import {
  type CheckboxConfig,
  type NormalizedChoice,
  normalizeChoices,
} from "./selection-types.js";

export type CheckboxSearchMode = "inactive" | "editing" | "locked";

export type CheckboxEntry<T> = SelectionEntry<NormalizedChoice<T>>;

export interface CheckboxView<T> {
  readonly active: NormalizedChoice<T> | undefined;
  readonly activeIndex: number;
  readonly entries: readonly CheckboxEntry<T>[];
  readonly error: string | undefined;
  readonly searchMode: CheckboxSearchMode;
  readonly searchText: string;
}

type CheckboxEffect<T> =
  | { readonly type: "cancel" }
  | { readonly type: "complete"; readonly values: readonly T[] }
  | undefined;

function selectable<T>(choice: NormalizedChoice<T>): boolean {
  return !choice.disabled;
}

function printableInput(data: string): string | undefined {
  if (data.length === 1 && data >= " ") return data;
  return decodeKittyPrintable(data);
}

export class CheckboxModel<T> {
  private readonly items: NormalizedChoice<T>[];
  private readonly selection: SelectionListModel<NormalizedChoice<T>>;
  private searchMode: CheckboxSearchMode = "inactive";
  private searchText = "";
  private error: string | undefined;

  constructor(private readonly config: CheckboxConfig<T>) {
    this.items = normalizeChoices(config.choices);
    this.selection = new SelectionListModel(this.items, {
      isSelectable: selectable,
      loop: config.loop !== false,
    });
  }

  view(): CheckboxView<T> {
    const entries = this.filteredEntries();
    this.ensureVisibleActive(entries);
    return {
      active: this.selection.active,
      activeIndex: this.selection.activeIndex,
      entries: this.selection.page(entries, this.config.pageSize ?? 7),
      error: this.error,
      searchMode: this.searchMode,
      searchText: this.searchText,
    };
  }

  handleInput(data: string): CheckboxEffect<T> {
    if (matchesKey(data, Key.ctrl("c"))) return { type: "cancel" };
    return this.searchMode === "editing"
      ? this.handleSearchInput(data)
      : this.handleSelectionInput(data);
  }

  private filteredEntries(): CheckboxEntry<T>[] {
    const query =
      this.searchMode === "inactive" ? "" : this.searchText.toLowerCase();
    return this.items.flatMap((item, originalIndex) =>
      !query || item.name.toLowerCase().includes(query)
        ? [{ item, originalIndex }]
        : [],
    );
  }

  private ensureVisibleActive(entries: readonly CheckboxEntry<T>[]): void {
    this.selection.ensureVisible(entries);
  }

  private move(offset: number): void {
    this.selection.move(this.filteredEntries(), offset);
  }

  private toggleActive(): void {
    const choice = this.selection.active;
    if (!choice || !selectable(choice)) return;
    choice.checked = !choice.checked;
    this.error = undefined;
  }

  private submit(): CheckboxEffect<T> {
    const selected = this.items.filter(
      (choice) => choice.checked && selectable(choice),
    );
    if (this.config.required && selected.length === 0) {
      this.error = "At least one choice must be selected";
      return undefined;
    }
    return {
      type: "complete",
      values: selected.map((choice) => choice.value),
    };
  }

  private handleSearchInput(data: string): CheckboxEffect<T> {
    if (matchesKey(data, Key.escape)) this.clearSearch();
    else if (matchesKey(data, Key.enter)) this.searchMode = "locked";
    else if (matchesKey(data, Key.up)) this.move(-1);
    else if (matchesKey(data, Key.down)) this.move(1);
    else if (matchesKey(data, Key.space)) this.toggleActive();
    else if (matchesKey(data, Key.backspace)) this.removeSearchCharacter();
    else this.appendPrintable(data);
    return undefined;
  }

  private handleSelectionInput(data: string): CheckboxEffect<T> {
    if (matchesKey(data, Key.escape) && this.searchMode === "locked") {
      this.searchMode = "editing";
    } else if (matchesKey(data, Key.slash)) {
      this.beginSearch();
    } else if (matchesKey(data, Key.enter)) {
      return this.submit();
    } else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.move(-1);
    } else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.move(1);
    } else if (matchesKey(data, Key.space)) {
      this.toggleActive();
    } else {
      this.handleSelectionCommand(data);
    }
    return undefined;
  }

  private handleSelectionCommand(data: string): void {
    if (matchesKey(data, "c") && this.searchMode === "locked") {
      this.clearSearch();
    } else if (matchesKey(data, "a")) {
      this.selectAll();
    } else if (matchesKey(data, "i")) {
      this.invertSelection();
    }
  }

  private clearSearch(): void {
    this.searchMode = "inactive";
    this.searchText = "";
    this.selection.reset();
  }

  private beginSearch(): void {
    const keepSearch = this.searchMode === "locked";
    this.searchMode = "editing";
    if (!keepSearch) this.searchText = "";
  }

  private removeSearchCharacter(): void {
    this.searchText = this.searchText.slice(0, -1);
    this.ensureVisibleActive(this.filteredEntries());
  }

  private appendPrintable(data: string): void {
    const printable = printableInput(data);
    if (!printable) return;
    this.searchText += printable;
    this.ensureVisibleActive(this.filteredEntries());
  }

  private selectAll(): void {
    const checked = this.items.some(
      (choice) => selectable(choice) && !choice.checked,
    );
    for (const choice of this.items) {
      if (selectable(choice)) choice.checked = checked;
    }
  }

  private invertSelection(): void {
    for (const choice of this.items) {
      if (selectable(choice)) choice.checked = !choice.checked;
    }
  }
}
