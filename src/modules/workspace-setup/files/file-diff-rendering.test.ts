import { describe, expect, test } from "bun:test";
import { generateUnifiedDiff } from "./file-diff-rendering.js";

describe("generateUnifiedDiff", () => {
  test("returns empty string for identical content", () => {
    const content = "line 1\nline 2\nline 3\n";
    expect(generateUnifiedDiff(content, content)).toBe("");
  });

  test("generates diff for added lines", () => {
    const oldContent = "line 1\nline 2\nline 3\n";
    const newContent = "line 1\nline 2\nnew line\nline 3\n";
    const diff = generateUnifiedDiff(oldContent, newContent);

    expect(diff).toContain("+new line");
    expect(diff).toContain("@@");
  });

  test("generates diff for removed lines", () => {
    const oldContent = "line 1\nline 2\nline 3\n";
    const newContent = "line 1\nline 3\n";
    const diff = generateUnifiedDiff(oldContent, newContent);

    expect(diff).toContain("-line 2");
    expect(diff).toContain("@@");
  });

  test("generates diff for modified lines", () => {
    const oldContent = "line 1\nold line\nline 3\n";
    const newContent = "line 1\nnew line\nline 3\n";
    const diff = generateUnifiedDiff(oldContent, newContent);

    expect(diff).toContain("-old line");
    expect(diff).toContain("+new line");
  });

  test("uses custom labels", () => {
    const oldContent = "a\n";
    const newContent = "b\n";
    const diff = generateUnifiedDiff(oldContent, newContent, "before", "after");

    expect(diff).toContain("--- before");
    expect(diff).toContain("+++ after");
  });

  test("uses default labels", () => {
    const oldContent = "a\n";
    const newContent = "b\n";
    const diff = generateUnifiedDiff(oldContent, newContent);

    expect(diff).toContain("--- current");
    expect(diff).toContain("+++ updated");
  });
});
