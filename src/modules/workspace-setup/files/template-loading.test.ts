import { describe, expect, test } from "bun:test";
import { loadTemplate } from "./template-loading.js";

describe("loadTemplate", () => {
  test("throws for non-existent file", () => {
    expect(() => loadTemplate("non-existent-file.txt")).toThrow();
  });
});
