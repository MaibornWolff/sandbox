import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { readState, writeState } from "./index.js";

describe("readState", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir("state-read");
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it("returns empty object when file does not exist", () => {
    const statePath = path.join(testDir, "state.json");
    expect(readState(statePath)).toEqual({});
  });

  it("returns empty object when file is corrupt JSON", () => {
    const statePath = path.join(testDir, "state.json");
    fs.writeFileSync(statePath, "not json{{{");
    expect(readState(statePath)).toEqual({});
  });

  it("returns state that matches the declared schema", () => {
    const statePath = path.join(testDir, "state.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        latestVersion: "1.2.3",
        templateHashes: { config: "abc" },
        unknown: "preserved",
      }),
    );
    expect(readState(statePath)).toEqual({
      latestVersion: "1.2.3",
      templateHashes: { config: "abc" },
      unknown: "preserved",
    });
  });

  it("returns empty state when a known field is invalid", () => {
    const statePath = path.join(testDir, "state.json");
    fs.writeFileSync(statePath, JSON.stringify({ latestVersion: 123 }));
    expect(readState(statePath)).toEqual({});
  });
});

describe("writeState", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir("state-write");
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  it("creates the file if it does not exist", () => {
    const statePath = path.join(testDir, "state.json");
    writeState({ latestVersion: "1.2.3" }, statePath);
    expect(readState(statePath)).toEqual({ latestVersion: "1.2.3" });
  });

  it("preserves existing keys when writing new ones", () => {
    const statePath = path.join(testDir, "state.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({ templateHashes: { config: "keep-me" } }),
    );
    writeState({ latestVersion: "1.2.3" }, statePath);
    expect(readState(statePath)).toEqual({
      templateHashes: { config: "keep-me" },
      latestVersion: "1.2.3",
    });
  });

  it("overwrites existing keys with new values", () => {
    const statePath = path.join(testDir, "state.json");
    fs.writeFileSync(statePath, JSON.stringify({ latestVersion: "1.0.0" }));
    writeState({ latestVersion: "2.0.0" }, statePath);
    expect(readState(statePath)).toEqual({ latestVersion: "2.0.0" });
  });

  it("creates parent directories if missing", () => {
    const nestedPath = path.join(testDir, "a", "b", "c", "state.json");
    writeState({ latestVersion: "1.2.3" }, nestedPath);
    expect(readState(nestedPath)).toEqual({ latestVersion: "1.2.3" });
  });

  it("round-trips writes and reads", () => {
    const statePath = path.join(testDir, "state.json");
    const data = { templateHashes: { a: "abc" }, latestVersion: "1.2.3" };
    writeState(data, statePath);
    expect(readState(statePath)).toEqual(data);
  });
});
