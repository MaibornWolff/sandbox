import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createEditorFixture } from "#platform/terminal/__test__/index.js";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  cleanupTempFile,
  createFilesSilently,
  processFileUpdate,
  processFileUpdates,
  writeTempFile,
} from "./file-updating.js";
import type { FileDefinition } from "./generated-file-definition.js";

function definition(filePath: string, content: string): FileDefinition {
  return {
    id: path.basename(filePath),
    name: path.basename(filePath),
    getPath: () => filePath,
    getTemplate: () => content,
  };
}

describe("file updating", () => {
  let root: string;
  let lastOutput: string;

  beforeEach(() => {
    root = createTestDir("file-update");
    lastOutput = "";
  });

  afterEach(() => cleanupTestDir(root));

  async function scoped<T>(operation: () => T): Promise<T> {
    const execution = await runInHostTestScope({ root }, ({ processes }) => {
      createEditorFixture({
        processes,
        platform: "linux",
      }).givenAvailableEditors([]);
      return operation();
    });
    lastOutput = execution.stdout;
    return execution.result;
  }

  it("creates and cleans temporary files", () => {
    const temporaryPath = writeTempFile("docker/Dockerfile", "FROM ubuntu");
    expect(path.basename(temporaryPath)).toBe("docker-Dockerfile");
    expect(fs.readFileSync(temporaryPath, "utf8")).toBe("FROM ubuntu");
    cleanupTempFile(temporaryPath);
    expect(fs.existsSync(temporaryPath)).toBe(false);
  });

  it("creates a missing file and reports its final state", async () => {
    const filePath = path.join(root, "config.toml");
    const result = await scoped(() =>
      processFileUpdate(definition(filePath, "new content"), []),
    );
    expect(result.action).toBe("created");
    expect(fs.readFileSync(filePath, "utf8")).toBe("new content");
    expect(lastOutput).toContain("Created");
  });

  it("keeps identical files unchanged", async () => {
    const filePath = path.join(root, "config.toml");
    fs.writeFileSync(filePath, "same content");
    const result = await scoped(() =>
      processFileUpdate(definition(filePath, "same content"), []),
    );
    expect(result.action).toBe("up-to-date");
  });

  it("applies explicit overwrite and skip decisions", async () => {
    const overwritePath = path.join(root, "overwrite.toml");
    const skipPath = path.join(root, "skip.toml");
    fs.writeFileSync(overwritePath, "old");
    fs.writeFileSync(skipPath, "old");

    const overwritten = await scoped(() =>
      processFileUpdate(definition(overwritePath, "new"), [], "overwrite"),
    );
    const skipped = await scoped(() =>
      processFileUpdate(definition(skipPath, "new"), [], "skip"),
    );

    expect(overwritten.action).toBe("updated");
    expect(skipped.action).toBe("skipped");
    expect(fs.readFileSync(overwritePath, "utf8")).toBe("new");
    expect(fs.readFileSync(skipPath, "utf8")).toBe("old");
  });

  it("creates all files on first run and uses diff behavior on rerun", async () => {
    const definitions = [
      definition(path.join(root, "config.toml"), "config"),
      definition(path.join(root, "Dockerfile"), "FROM base"),
    ];
    const first = await scoped(() => processFileUpdates(definitions, []));
    const second = await scoped(() => processFileUpdates(definitions, []));
    expect(first.map((result) => result.action)).toEqual([
      "created",
      "created",
    ]);
    expect(second.map((result) => result.action)).toEqual([
      "up-to-date",
      "up-to-date",
    ]);
  });

  it("creates files silently with requested tool IDs", async () => {
    let received: string[] = [];
    const filePath = path.join(root, "config.toml");
    const def: FileDefinition = {
      ...definition(filePath, "unused"),
      getTemplate(toolIds) {
        received = toolIds;
        return "content";
      },
    };
    const results = await scoped(() => createFilesSilently([def], ["node"]));
    expect(results[0]?.action).toBe("created");
    expect(received).toEqual(["node"]);
  });
});
