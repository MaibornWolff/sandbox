import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  createFile,
  ensureDirectory,
  ensurePath,
  exists,
  removeOwnedDirectory,
  setPathModifiedTime,
} from "./file.js";

let testDir: string;

beforeEach(() => {
  testDir = createTestDir("file-utils-test");
});

afterEach(() => {
  cleanupTestDir(testDir);
});

describe("removeOwnedDirectory", () => {
  it("removes read-only owned trees without changing symbolic-link targets", () => {
    const external = path.join(testDir, "external.txt");
    const owned = path.join(testDir, "owned");
    const nested = path.join(owned, "readonly");
    fs.writeFileSync(external, "outside", { mode: 0o444 });
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "data"), "inside", { mode: 0o444 });
    fs.symlinkSync(external, path.join(owned, "external"), "file");
    fs.chmodSync(nested, 0o555);
    const externalMode = fs.statSync(external).mode;
    removeOwnedDirectory(owned);
    expect(fs.existsSync(owned)).toBe(false);
    expect(fs.readFileSync(external, "utf8")).toBe("outside");
    expect(fs.statSync(external).mode).toBe(externalMode);
    removeOwnedDirectory(owned);
  });
});

describe("setPathModifiedTime", () => {
  it("sets the modification time supplied by the caller", () => {
    const filePath = path.join(testDir, "timestamped");
    fs.writeFileSync(filePath, "content");
    const modifiedAt = Date.UTC(2026, 0, 1);

    setPathModifiedTime(filePath, modifiedAt);

    expect(fs.statSync(filePath).mtimeMs).toBe(modifiedAt);
  });
});

describe("ensureDirectory", () => {
  it("creates directory if it doesn't exist", () => {
    const dirPath = path.join(testDir, "new-dir");
    expect(fs.existsSync(dirPath)).toBe(false);

    ensureDirectory(dirPath);

    expect(fs.existsSync(dirPath)).toBe(true);
    expect(fs.statSync(dirPath).isDirectory()).toBe(true);
  });

  it("creates nested directories", () => {
    const dirPath = path.join(testDir, "a", "b", "c");
    expect(fs.existsSync(dirPath)).toBe(false);

    ensureDirectory(dirPath);

    expect(fs.existsSync(dirPath)).toBe(true);
    expect(fs.statSync(dirPath).isDirectory()).toBe(true);
  });

  it("does nothing if directory already exists", () => {
    const dirPath = path.join(testDir, "existing");
    fs.mkdirSync(dirPath);

    ensureDirectory(dirPath);

    expect(fs.existsSync(dirPath)).toBe(true);
  });
});

describe("createFile", () => {
  it("creates new file with content", () => {
    const filePath = path.join(testDir, "test.txt");
    const content = "Hello, world!";

    const result = createFile(filePath, content);

    expect(result.created).toBe(true);
    expect(result.overwritten).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(filePath, "utf-8")).toBe(content);
  });

  it("creates parent directories if needed", () => {
    const filePath = path.join(testDir, "nested", "dir", "file.txt");
    const content = "test content";

    const result = createFile(filePath, content);

    expect(result.created).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe(content);
  });

  it("skips existing file without force option", () => {
    const filePath = path.join(testDir, "existing.txt");
    fs.writeFileSync(filePath, "original");

    const result = createFile(filePath, "new content");

    expect(result.created).toBe(false);
    expect(result.overwritten).toBe(false);
    expect(result.skipped).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("original");
  });

  it("overwrites existing file with force option", () => {
    const filePath = path.join(testDir, "existing.txt");
    fs.writeFileSync(filePath, "original");

    const result = createFile(filePath, "new content", { force: true });

    expect(result.created).toBe(false);
    expect(result.overwritten).toBe(true);
    expect(result.skipped).toBe(false);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("new content");
  });

  it("returns error on write failure", () => {
    // Skip on root - chmod doesn't restrict root user
    if (process.getuid?.() === 0) {
      return;
    }

    const invalidPath = path.join(testDir, "nonexistent", "file.txt");

    // Make parent directory readonly to cause write failure
    const parentDir = path.dirname(invalidPath);
    fs.mkdirSync(parentDir);
    fs.chmodSync(parentDir, 0o444);

    const result = createFile(invalidPath, "content");

    expect(result.created).toBe(false);
    expect(result.error).toBeDefined();

    // Cleanup: restore permissions
    fs.chmodSync(parentDir, 0o755);
  });
});

describe("exists", () => {
  it("returns true for existing file", async () => {
    const filePath = path.join(testDir, "existing.txt");
    fs.writeFileSync(filePath, "content");

    expect(await exists(filePath)).toBe(true);
  });

  it("returns true for existing directory", async () => {
    const dirPath = path.join(testDir, "existing-dir");
    fs.mkdirSync(dirPath);

    expect(await exists(dirPath)).toBe(true);
  });

  it("returns false for non-existing path", async () => {
    const nonExisting = path.join(testDir, "does-not-exist");

    expect(await exists(nonExisting)).toBe(false);
  });
});

describe("ensurePath", () => {
  it("creates directory if it doesn't exist", async () => {
    const dirPath = path.join(testDir, "new-persist-dir");
    expect(fs.existsSync(dirPath)).toBe(false);

    const created = await ensurePath(dirPath);

    expect(created).toBe(true);
    expect(fs.existsSync(dirPath)).toBe(true);
    expect(fs.statSync(dirPath).isDirectory()).toBe(true);
  });

  it("creates nested directories", async () => {
    const dirPath = path.join(testDir, "deep", "nested", "dir");
    expect(fs.existsSync(dirPath)).toBe(false);

    const created = await ensurePath(dirPath);

    expect(created).toBe(true);
    expect(fs.existsSync(dirPath)).toBe(true);
  });

  it("creates file with default content", async () => {
    const filePath = path.join(testDir, "config.json");
    const defaultContent = "{}";

    const created = await ensurePath(filePath, defaultContent);

    expect(created).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe(defaultContent);
  });

  it("creates file in nested directory with default content", async () => {
    const filePath = path.join(testDir, "nested", "config.json");
    const defaultContent = '{"key": "value"}';

    const created = await ensurePath(filePath, defaultContent);

    expect(created).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe(defaultContent);
  });

  it("does not overwrite existing directory", async () => {
    const dirPath = path.join(testDir, "existing-dir");
    fs.mkdirSync(dirPath);

    const created = await ensurePath(dirPath);

    expect(created).toBe(false);
    expect(fs.existsSync(dirPath)).toBe(true);
  });

  it("does not overwrite existing file", async () => {
    const filePath = path.join(testDir, "existing.json");
    fs.writeFileSync(filePath, "original");

    const created = await ensurePath(filePath, "new content");

    expect(created).toBe(false);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("original");
  });
});
