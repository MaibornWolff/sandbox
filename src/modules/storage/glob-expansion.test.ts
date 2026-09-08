import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  expandGlob as expandGlobWithoutScope,
  filterNestedPaths,
} from "./glob-expansion.js";

function expandGlob(
  ...args: Parameters<typeof expandGlobWithoutScope>
): ReturnType<typeof expandGlobWithoutScope> {
  return runWithTestLogger(() => expandGlobWithoutScope(...args));
}

// Helper to create nested directories
async function createDirs(base: string, dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    await fs.mkdir(path.join(base, dir), { recursive: true });
  }
}

describe("expandGlob", () => {
  let testDir: string;

  beforeEach(async () => {
    // Create test directory structure
    testDir = createTestDir("glob");
    await createDirs(testDir, [
      "apps/web/node_modules",
      "apps/api/node_modules",
      "packages/ui/node_modules",
      "node_modules",
      ".git/objects",
    ]);
  });

  afterEach(() => cleanupTestDir(testDir));

  // Basic matching
  test("matches directories at any depth with **", async () => {
    const result = await expandGlob({
      cwd: testDir,
      pattern: "./**/node_modules",
    });
    expect(result).toContain("./node_modules");
    expect(result).toContain("./apps/web/node_modules");
    expect(result).toContain("./apps/api/node_modules");
    expect(result).toContain("./packages/ui/node_modules");
  });

  test("matches directories at single level with *", async () => {
    const result = await expandGlob({
      cwd: testDir,
      pattern: "./apps/*/node_modules",
    });
    expect(result).toEqual(
      expect.arrayContaining([
        "./apps/web/node_modules",
        "./apps/api/node_modules",
      ]),
    );
    expect(result).not.toContain("./packages/ui/node_modules");
  });

  // Edge cases
  test("returns empty array when no matches", async () => {
    const result = await expandGlob({
      cwd: testDir,
      pattern: "./**/nonexistent",
    });
    expect(result).toEqual([]);
  });

  test("does not recurse into node_modules", async () => {
    // Create nested node_modules inside node_modules
    await createDirs(testDir, ["node_modules/pkg/node_modules"]);

    const result = await expandGlob({
      cwd: testDir,
      pattern: "./**/node_modules",
    });

    // Should NOT include node_modules/pkg/node_modules
    expect(result).not.toContain("./node_modules/pkg/node_modules");
  });

  test("does not recurse into .git", async () => {
    const result = await expandGlob({
      cwd: testDir,
      pattern: "./**/objects", // .git/objects exists
    });
    expect(result).not.toContain("./.git/objects");
  });

  test("matches dotdirs when pattern includes them", async () => {
    await createDirs(testDir, [".venv/lib"]);
    const result = await expandGlob({
      cwd: testDir,
      pattern: "./**/.venv",
    });
    expect(result).toContain("./.venv");
  });

  test("does not follow symlinks", async () => {
    await fs.symlink("/tmp", path.join(testDir, "link_to_tmp"));

    const result = await expandGlob({
      cwd: testDir,
      pattern: "./**/node_modules",
    });

    // Should not crash or include paths from /tmp
    expect(result.every((p) => p.startsWith("./"))).toBe(true);
  });

  test("returns empty array for empty pattern after normalization", async () => {
    const result = await expandGlob({
      cwd: testDir,
      pattern: "./",
    });
    expect(result).toEqual([]);
  });

  test("returns empty array and logs warning on glob error", async () => {
    // Use non-existent cwd to trigger an error
    const result = await expandGlob({
      cwd: "/nonexistent/path/that/does/not/exist",
      pattern: "./**/node_modules",
    });
    expect(result).toEqual([]);
  });
});

describe("filterNestedPaths", () => {
  test("removes paths that are children of other matches", () => {
    const input = [
      "apps/node_modules",
      "apps/node_modules/lodash/node_modules",
      "packages/node_modules",
    ];
    const result = filterNestedPaths(input);
    expect(result).toEqual(["apps/node_modules", "packages/node_modules"]);
  });

  test("keeps all paths when none are nested", () => {
    const input = [
      "apps/node_modules",
      "packages/node_modules",
      "node_modules",
    ];
    const result = filterNestedPaths(input);
    // Note: order may change due to sorting by length
    expect(result).toEqual(
      expect.arrayContaining([
        "apps/node_modules",
        "packages/node_modules",
        "node_modules",
      ]),
    );
    expect(result).toHaveLength(3);
  });

  test("handles empty input", () => {
    expect(filterNestedPaths([])).toEqual([]);
  });

  test("handles single path", () => {
    expect(filterNestedPaths(["node_modules"])).toEqual(["node_modules"]);
  });

  test("handles deeply nested duplicates", () => {
    const input = ["a", "a/b", "a/b/c", "a/b/c/d", "x/y"];
    const result = filterNestedPaths(input);
    expect(result).toEqual(["a", "x/y"]);
  });
});
