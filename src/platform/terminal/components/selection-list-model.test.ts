import { describe, expect, test } from "bun:test";
import { SelectionListModel } from "./selection-list-model.js";

const items = ["one", "two", "three", "four", "five"];

describe("SelectionListModel", () => {
  test("centers the active entry when surrounding entries are available", () => {
    const model = new SelectionListModel(items, {
      isSelectable: () => true,
      loop: false,
    });

    model.move(model.entries(), 1);
    model.move(model.entries(), 1);

    expect(model.page(model.entries(), 3).map((entry) => entry.item)).toEqual([
      "two",
      "three",
      "four",
    ]);
  });

  test("clamps the page and selection at list boundaries", () => {
    const model = new SelectionListModel(items, {
      isSelectable: () => true,
      loop: false,
    });

    model.move(model.entries(), 20);

    expect(model.active).toBe("five");
    expect(model.page(model.entries(), 3).map((entry) => entry.item)).toEqual([
      "three",
      "four",
      "five",
    ]);
  });
});
