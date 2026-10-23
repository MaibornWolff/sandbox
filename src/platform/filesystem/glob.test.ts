import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { globPaths } from "./glob.js";

function createFixture() {
  const root = createTestDir("glob-paths");
  mkdirSync(path.join(root, "settings", "nested"), { recursive: true });
  writeFileSync(path.join(root, "settings", "keep.json"), "keep");
  writeFileSync(path.join(root, "settings", "excluded.json"), "excluded");
  writeFileSync(path.join(root, "settings", ".hidden.json"), "hidden");
  writeFileSync(path.join(root, "settings", "nested", "other.json"), "other");
  return {
    root,
    [Symbol.dispose]: () => cleanupTestDir(root),
  };
}

test("selects literal directories without expanding their contents", async () => {
  using fixture = createFixture();
  expect(
    await globPaths("settings", { cwd: fixture.root, onlyFiles: false }),
  ).toEqual(["settings"]);
});

test("selects recursive contents without returning the parent or excluded files", async () => {
  using fixture = createFixture();
  const matches = await globPaths("settings/**", {
    cwd: fixture.root,
    dot: true,
    onlyFiles: false,
    ignore: ["**/excluded.json"],
  });
  expect(matches.sort()).toEqual([
    "settings/.hidden.json",
    "settings/keep.json",
    "settings/nested",
    "settings/nested/other.json",
  ]);
});

test("matches a bare globstar without selecting its working directory", async () => {
  using fixture = createFixture();
  const matches = await globPaths("**", {
    cwd: fixture.root,
    dot: true,
    onlyFiles: false,
  });
  expect(matches.sort()).toEqual([
    "settings",
    "settings/.hidden.json",
    "settings/excluded.json",
    "settings/keep.json",
    "settings/nested",
    "settings/nested/other.json",
  ]);
});

test("treats negated extglobs as inclusion patterns", async () => {
  using fixture = createFixture();
  const matches = await globPaths("!(other)/**", {
    cwd: fixture.root,
    dot: true,
    onlyFiles: false,
  });
  expect(matches.sort()).toEqual([
    "settings/.hidden.json",
    "settings/excluded.json",
    "settings/keep.json",
    "settings/nested",
    "settings/nested/other.json",
  ]);
});

test("excludes a complete directory tree with a negative globstar", async () => {
  using fixture = createFixture();
  expect(
    await globPaths(["**/*", "!settings/**"], {
      cwd: fixture.root,
      onlyFiles: false,
    }),
  ).toEqual([]);
});

test("returns directory paths without trailing slashes", async () => {
  using fixture = createFixture();
  expect(
    await globPaths("settings/*", {
      cwd: fixture.root,
      onlyDirectories: true,
    }),
  ).toEqual(["settings/nested"]);
});

test("deduplicates overlapping patterns and applies negative patterns", async () => {
  using fixture = createFixture();
  expect(
    await globPaths(
      ["settings/keep.json", "settings/*.json", "!settings/excluded.json"],
      { cwd: fixture.root },
    ),
  ).toEqual(["settings/keep.json"]);
});

test("follows symbolic links when requested", async () => {
  using fixture = createFixture();
  symlinkSync(
    path.join(fixture.root, "settings"),
    path.join(fixture.root, "linked"),
    "dir",
  );
  expect(
    await globPaths("linked/keep.json", {
      cwd: fixture.root,
      followSymbolicLinks: true,
    }),
  ).toEqual(["linked/keep.json"]);
});

test("returns symbolic links without traversing them when matching all path types", async () => {
  using fixture = createFixture();
  symlinkSync(
    path.join(fixture.root, "settings"),
    path.join(fixture.root, "linked"),
    "dir",
  );
  const matches = await globPaths("**/*", {
    cwd: fixture.root,
    onlyFiles: false,
    followSymbolicLinks: false,
  });
  expect(matches).toContain("linked");
  expect(matches).not.toContain("linked/keep.json");
});

test("does not follow symbolic links when disabled", async () => {
  using fixture = createFixture();
  symlinkSync(
    path.join(fixture.root, "settings"),
    path.join(fixture.root, "linked"),
    "dir",
  );
  expect(
    await globPaths("*/keep.json", {
      cwd: fixture.root,
      followSymbolicLinks: false,
    }),
  ).toEqual(["settings/keep.json"]);
});
