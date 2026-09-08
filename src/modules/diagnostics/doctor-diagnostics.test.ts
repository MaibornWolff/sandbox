import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PersistPathInput } from "#modules/configuration/index.js";
import { normalizeSettingsPattern } from "#modules/configuration/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { checkMountConflicts } from "./configuration-diagnostics.js";
import {
  checkPatternMatches,
  checkSettingsPatterns,
} from "./settings-diagnostics.js";

describe("checkMountConflicts", () => {
  test("returns empty array when no conflicts", () => {
    const persistPaths: PersistPathInput[] = [{ path: "~/.cache" }];
    const settings = [".other/*.json"];

    const warnings = checkMountConflicts(persistPaths, settings);
    expect(warnings).toEqual([]);
  });

  test("returns empty array when no persist paths", () => {
    const persistPaths: PersistPathInput[] = [];
    const settings = [".claude.json", ".codex/*.toml"];

    const warnings = checkMountConflicts(persistPaths, settings);
    expect(warnings).toEqual([]);
  });

  test("returns empty array when no settings", () => {
    const persistPaths: PersistPathInput[] = [
      { path: "/home/sandbox/.config" },
    ];
    const settings: string[] = [];

    const warnings = checkMountConflicts(persistPaths, settings);
    expect(warnings).toEqual([]);
  });

  test("warns about deprecated .claude.json pattern when home is persisted", () => {
    const persistPaths: PersistPathInput[] = [{ path: "/home/sandbox" }];
    const settings = [".claude.json"];

    const warnings = checkMountConflicts(persistPaths, settings);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(".claude.json");
    expect(warnings[0]).toContain("auto-persisted");
  });

  test("warns about deprecated .codex/*.toml pattern when home is persisted", () => {
    const persistPaths: PersistPathInput[] = [{ path: "/home/sandbox/.local" }];
    const settings = [".codex/*.toml"];

    const warnings = checkMountConflicts(persistPaths, settings);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(".codex/*.toml");
  });

  test("warns about multiple deprecated patterns", () => {
    const persistPaths: PersistPathInput[] = [{ path: "/home/sandbox" }];
    const settings = [".claude.json", ".codex/*.toml", ".other/*.json"];

    const warnings = checkMountConflicts(persistPaths, settings);
    expect(warnings.length).toBe(2);
  });

  test("does not expand tilde paths (uses literal comparison)", () => {
    // Note: checkMountConflicts uses literal path comparison, tilde is not expanded
    const persistPaths: PersistPathInput[] = [{ path: "~" }];
    const settings = [".claude.json"];

    const warnings = checkMountConflicts(persistPaths, settings);
    // Tilde paths don't match /home/sandbox pattern
    expect(warnings.length).toBe(0);
  });
});

describe("checkPatternMatches", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir("doctor-test");
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  test("returns matched=true for exclusion patterns", () => {
    const result = checkPatternMatches(testDir, "!node_modules");
    expect(result.matched).toBe(true);
    expect(result.files).toEqual([]);
  });

  test("returns matched=true for glob-only patterns", () => {
    const result = checkPatternMatches(testDir, "**/*.json");
    expect(result.matched).toBe(true);
  });

  test("returns matched=true when directory exists", () => {
    fs.mkdirSync(path.join(testDir, ".claude"), { recursive: true });

    const result = checkPatternMatches(testDir, ".claude/*.json");
    expect(result.matched).toBe(true);
    expect(result.files).toContain(".claude");
  });

  test("returns matched=false when directory does not exist", () => {
    const result = checkPatternMatches(testDir, ".nonexistent/*.json");
    expect(result.matched).toBe(false);
    expect(result.files).toEqual([]);
  });

  test("returns matched=true when file exists", () => {
    fs.writeFileSync(path.join(testDir, "config.json"), "{}");

    const result = checkPatternMatches(testDir, "config.json");
    expect(result.matched).toBe(true);
    expect(result.files).toContain("config.json");
  });

  test("handles empty pattern", () => {
    const result = checkPatternMatches(testDir, "");
    expect(result.matched).toBe(false);
  });

  test("handles pattern with only slash", () => {
    const result = checkPatternMatches(testDir, "/");
    expect(result.matched).toBe(false);
  });

  test("returns matched=false when nested directory does not exist", () => {
    // Create parent but not nested dir
    fs.mkdirSync(path.join(testDir, ".claude"), { recursive: true });

    const result = checkPatternMatches(testDir, ".claude/nonexistent/");
    expect(result.matched).toBe(false);
  });

  test("returns matched=true when nested directory exists", () => {
    fs.mkdirSync(path.join(testDir, ".claude", "skills"), { recursive: true });

    const result = checkPatternMatches(testDir, ".claude/skills/");
    expect(result.matched).toBe(true);
  });

  test("stops checking at glob segment", () => {
    // Create parent but nested glob can't be verified
    fs.mkdirSync(path.join(testDir, ".claude"), { recursive: true });

    const result = checkPatternMatches(testDir, ".claude/*.json");
    expect(result.matched).toBe(true);
  });

  test("matches using normalized pattern (strips ~/ prefix)", () => {
    // Create nested directory in settings dir
    fs.mkdirSync(path.join(testDir, ".claude", "foo"), { recursive: true });

    // Pattern with ~/ prefix should be normalized before matching
    const pattern = "~/.claude/foo";
    const normalizedPattern = normalizeSettingsPattern(pattern);

    expect(normalizedPattern).toBe(".claude/foo");

    // The normalized pattern should match the actual nested path
    const result = checkPatternMatches(testDir, normalizedPattern);
    expect(result.matched).toBe(true);
    expect(result.files).toContain(".claude");
  });
});

describe("checkSettingsPatterns", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir("settings-patterns-test");
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  test("normalizes patterns with ~/ prefix before matching", () => {
    // Create nested directory in settings dir
    fs.mkdirSync(path.join(testDir, ".claude", "foo"), { recursive: true });

    // Pass pattern with ~/ prefix (as stored in config)
    const result = checkSettingsPatterns(testDir, ["~/.claude/foo"]);

    // Should match because .claude/foo exists
    expect(result.matchedFiles).toContain(".claude");
    expect(result.unmatchedPatterns).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("reports unmatched patterns without adding warnings", () => {
    // Don't create .nonexistent directory

    const result = checkSettingsPatterns(testDir, ["~/.nonexistent/bar"]);

    expect(result.unmatchedPatterns).toEqual(["~/.nonexistent/bar"]);
    // Unmatched patterns are informational, not warnings
    expect(result.warnings).toEqual([]);
  });
});
