import { describe, expect, test } from "bun:test";
import { defineCategory } from "./category-definition.js";
import type { ToolDefinition } from "./tool-definition.js";
import {
  getDependents,
  resolveTools,
  setDirectSelection,
} from "./tool-resolution.js";

const testCategory = defineCategory({
  id: "test",
  name: "Test",
  section: "tools",
  description: "Test tools",
});

function defineTestTool(
  id: string,
  requires: readonly ToolDefinition[] = [],
): ToolDefinition {
  return {
    id,
    name: id,
    description: `${id} tool`,
    category: testCategory,
    requires,
  };
}

const base = defineTestTool("base");
const shared = defineTestTool("shared", [base]);
const first = defineTestTool("first", [shared]);
const second = defineTestTool("second", [shared]);
const testRegistry = [base, shared, first, second];

describe("resolveTools", () => {
  test("returns direct and automatic selections with transitive reasons", () => {
    const result = resolveTools(["first"], testRegistry);

    expect(result.directSelections).toEqual([first]);
    expect(result.automaticSelections).toEqual([base, shared]);
    expect(result.dependencyClosure).toEqual([base, shared, first]);
    expect(result.dependencyReasons.get(shared)).toEqual([first]);
    expect(result.dependencyReasons.get(base)).toEqual([shared]);
  });

  test("deduplicates shared dependencies and exposes each reason", () => {
    const result = resolveTools(["first", "second"], testRegistry);

    expect(result.automaticSelections).toEqual([base, shared]);
    expect(result.dependencyReasons.get(shared)).toEqual([first, second]);
    expect(result.dependencyClosure).toEqual([base, shared, first, second]);
  });

  test("keeps a selected dependency direct", () => {
    const result = resolveTools(["shared", "first"], testRegistry);

    expect(result.directSelections).toEqual([shared, first]);
    expect(result.automaticSelections).toEqual([base]);
  });
});

describe("setDirectSelection", () => {
  test("promotes an automatic dependency to direct", () => {
    const directIds = setDirectSelection(
      ["first"],
      "shared",
      true,
      testRegistry,
    );

    expect(directIds).toEqual(["first", "shared"]);
    expect(resolveTools(directIds, testRegistry).automaticSelections).toEqual([
      base,
    ]);
  });

  test("demotes a direct dependency to automatic when it remains required", () => {
    const directIds = setDirectSelection(
      ["first", "shared"],
      "shared",
      false,
      testRegistry,
    );
    const result = resolveTools(directIds, testRegistry);

    expect(directIds).toEqual(["first"]);
    expect(result.automaticSelections).toContain(shared);
  });

  test("keeps a promoted dependency after its dependent is cleared", () => {
    const promoted = setDirectSelection(
      ["first"],
      "shared",
      true,
      testRegistry,
    );
    const directIds = setDirectSelection(
      promoted,
      "first",
      false,
      testRegistry,
    );

    expect(directIds).toEqual(["shared"]);
    expect(resolveTools(directIds, testRegistry).dependencyClosure).toEqual([
      base,
      shared,
    ]);
  });

  test("rejects removal of an automatic dependency with requiring tools", () => {
    expect(() =>
      setDirectSelection(["first", "second"], "shared", false, testRegistry),
    ).toThrow("Cannot remove required tool shared: required by first, second");
  });
});

describe("getDependents", () => {
  test("returns direct requiring capability names", () => {
    expect(getDependents("shared", ["first", "second"], testRegistry)).toEqual([
      "first",
      "second",
    ]);
  });
});
