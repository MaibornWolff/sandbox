export interface SelectionEntry<T> {
  readonly item: T;
  readonly originalIndex: number;
}

interface SelectionListOptions<T> {
  readonly isSelectable: (item: T) => boolean;
  readonly loop: boolean;
}

export class SelectionListModel<T> {
  private selectedIndex: number;

  constructor(
    private readonly items: readonly T[],
    private readonly options: SelectionListOptions<T>,
  ) {
    this.selectedIndex = this.firstSelectableIndex();
  }

  get activeIndex(): number {
    return this.selectedIndex;
  }

  get active(): T | undefined {
    return this.items[this.selectedIndex];
  }

  entries(): SelectionEntry<T>[] {
    return this.items.map((item, originalIndex) => ({ item, originalIndex }));
  }

  select(index: number): void {
    const item = this.items[index];
    if (item && this.options.isSelectable(item)) this.selectedIndex = index;
  }

  reset(): void {
    this.selectedIndex = this.firstSelectableIndex();
  }

  ensureVisible(entries: readonly SelectionEntry<T>[]): void {
    if (entries.some((entry) => entry.originalIndex === this.selectedIndex)) {
      return;
    }
    const first = entries.find((entry) =>
      this.options.isSelectable(entry.item),
    );
    if (first) this.selectedIndex = first.originalIndex;
  }

  move(entries: readonly SelectionEntry<T>[], offset: number): void {
    const indexes = entries
      .filter((entry) => this.options.isSelectable(entry.item))
      .map((entry) => entry.originalIndex);
    if (indexes.length === 0) return;
    const current = indexes.indexOf(this.selectedIndex);
    const next = current === -1 ? 0 : current + offset;
    if (this.options.loop) {
      this.selectedIndex =
        indexes[(next + indexes.length) % indexes.length] ?? this.selectedIndex;
      return;
    }
    this.selectedIndex =
      indexes[Math.max(0, Math.min(indexes.length - 1, next))] ??
      this.selectedIndex;
  }

  page(
    entries: readonly SelectionEntry<T>[],
    pageSize: number,
  ): SelectionEntry<T>[] {
    const active = Math.max(
      0,
      entries.findIndex((entry) => entry.originalIndex === this.selectedIndex),
    );
    const start = Math.max(
      0,
      Math.min(active - Math.floor(pageSize / 2), entries.length - pageSize),
    );
    return entries.slice(start, start + pageSize);
  }

  private firstSelectableIndex(): number {
    return Math.max(0, this.items.findIndex(this.options.isSelectable));
  }
}
