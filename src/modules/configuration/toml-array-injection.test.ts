import { describe, expect, test } from "bun:test";
import { parse as parseToml } from "smol-toml";
import { injectTomlArrayEntries } from "./toml-array-injection.js";

function inject(content: string): string[] {
  const result = injectTomlArrayEntries(content, "items", '  "new",');
  return (parseToml(result) as { items: string[] }).items;
}

describe("injectTomlArrayEntries", () => {
  test("keeps a quoted hash as a value, not a comment", () => {
    expect(inject('items = [\n  "a#b" # note\n]')).toEqual(["a#b", "new"]);
  });

  test("does not close the array at a quoted bracket", () => {
    expect(inject('items = [\n  "a]b",\n]\n')).toEqual(["a]b", "new"]);
    expect(inject("items = [\n  'c]d',\n]\n")).toEqual(["c]d", "new"]);
  });

  test("handles escaped quotes inside basic strings", () => {
    expect(inject('items = [\n  "say \\"]\\"" # x\n]')).toEqual([
      'say "]"',
      "new",
    ]);
  });

  test("still appends a comma before a trailing comment", () => {
    const result = injectTomlArrayEntries(
      'items = [\n  "a#b" # keep\n]',
      "items",
      '  "new",',
    );
    expect(result).toContain('"a#b", # keep');
  });
});
