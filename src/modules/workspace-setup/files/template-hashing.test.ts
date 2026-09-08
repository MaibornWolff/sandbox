import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import type { FileDefinition } from "./generated-file-definition.js";
import {
  computeTemplateHashesForDefinitions,
  loadStoredTemplateHashes,
  saveTemplateHashes,
  templateHashesDiffer,
} from "./template-hashing.js";

function definitions(templates: Record<string, string>): FileDefinition[] {
  return Object.entries(templates).map(([id, content]) => ({
    id,
    name: id,
    getPath: () => `/unused/${id}`,
    getTemplate: () => content,
  }));
}

describe("template hashing", () => {
  let root: string;
  let dataRoot: string;

  beforeEach(() => {
    root = createTestDir("template-hashes");
    dataRoot = path.join(root, "data");
  });

  afterEach(() => cleanupTestDir(root));

  function inEnvironment<T>(operation: () => T): T {
    return runWithTestLogger(operation, {
      currentWorkingDirectory: root,
      homeDirectory: path.join(root, "home"),
      variables: { XDG_DATA_HOME: dataRoot },
    });
  }

  it("computes SHA-256 hashes from explicit definitions", () => {
    const hashes = computeTemplateHashesForDefinitions(
      definitions({ config: "hello", dockerfile: "world" }),
      [],
    );
    expect(Object.keys(hashes)).toEqual(["config", "dockerfile"]);
    expect(hashes.config).toHaveLength(64);
    expect(hashes.config).not.toBe(hashes.dockerfile);
  });

  it("round-trips hashes through the scoped data root", () => {
    inEnvironment(() => saveTemplateHashes({ config: "abc123" }));
    expect(inEnvironment(() => loadStoredTemplateHashes())).toEqual({
      config: "abc123",
    });
    expect(fs.existsSync(path.join(dataRoot, "sandbox", "state.json"))).toBe(
      true,
    );
  });

  it("returns null for missing or malformed state", () => {
    expect(inEnvironment(() => loadStoredTemplateHashes())).toBeNull();
    fs.mkdirSync(path.join(dataRoot, "sandbox"), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "sandbox", "state.json"), "invalid");
    expect(inEnvironment(() => loadStoredTemplateHashes())).toBeNull();
  });

  it("detects changed, added, and removed templates", () => {
    expect(templateHashesDiffer(null, { config: "a" })).toBe(true);
    expect(templateHashesDiffer({ config: "a" }, { config: "a" })).toBe(false);
    expect(templateHashesDiffer({ config: "a" }, { config: "b" })).toBe(true);
    expect(
      templateHashesDiffer({ config: "a" }, { config: "a", dockerfile: "b" }),
    ).toBe(true);
    expect(
      templateHashesDiffer({ config: "a", dockerfile: "b" }, { config: "a" }),
    ).toBe(true);
  });
});
