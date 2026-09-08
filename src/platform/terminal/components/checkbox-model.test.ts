import { describe, expect, test } from "bun:test";
import { CheckboxModel } from "./checkbox-model.js";

const choices = [
  { value: "alpha", name: "Alpha" },
  { value: "beta", name: "Beta" },
  { value: "gamma", name: "Gamma" },
];

describe("CheckboxModel", () => {
  test("filters, selects, and completes without a terminal", () => {
    const model = new CheckboxModel({ message: "Tools", choices });

    model.handleInput("/");
    model.handleInput("b");
    model.handleInput("e");
    expect(model.view().entries.map((entry) => entry.item.name)).toEqual([
      "Beta",
    ]);

    model.handleInput("\r");
    model.handleInput(" ");
    expect(model.handleInput("\r")).toEqual({
      type: "complete",
      values: ["beta"],
    });
  });

  test("keeps the active choice inside the configured page", () => {
    const model = new CheckboxModel({
      message: "Tools",
      choices,
      pageSize: 2,
      loop: false,
    });

    model.handleInput("\u001b[B");
    model.handleInput("\u001b[B");

    const view = model.view();
    expect(view.active?.name).toBe("Gamma");
    expect(view.entries.map((entry) => entry.item.name)).toEqual([
      "Beta",
      "Gamma",
    ]);
  });

  test("reports a required empty selection", () => {
    const model = new CheckboxModel({
      message: "Tools",
      choices,
      required: true,
    });

    expect(model.handleInput("\r")).toBeUndefined();
    expect(model.view().error).toBe("At least one choice must be selected");
  });
});
