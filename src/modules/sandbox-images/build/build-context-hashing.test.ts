import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { listFilesRecursively } from "#platform/filesystem/index.js";
import {
  cleanupTestDir,
  createTestDir,
  getTestRepoRootPath,
} from "#test/utils.js";
import {
  getImageHash,
  hashBuildContextEntries,
} from "./build-context-hashing.js";

describe("getImageHash", () => {
  test("generates consistent hash for same content", () => {
    const tmpDir = createTestDir("docker-test");
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(dockerfilePath, "FROM ubuntu:24.04\nRUN echo hello");

    expect(getImageHash(dockerfilePath)).toBe(getImageHash(dockerfilePath));
    expect(getImageHash(dockerfilePath)).toHaveLength(12);
    cleanupTestDir(tmpDir);
  });

  test("generates different hashes for different content", () => {
    const firstDir = createTestDir("docker-test");
    const secondDir = createTestDir("docker-test");
    const firstDockerfile = path.join(firstDir, "Dockerfile");
    const secondDockerfile = path.join(secondDir, "Dockerfile");
    fs.writeFileSync(firstDockerfile, "FROM ubuntu:24.04\nRUN echo hello");
    fs.writeFileSync(secondDockerfile, "FROM ubuntu:24.04\nRUN echo world");

    expect(getImageHash(firstDockerfile)).not.toBe(
      getImageHash(secondDockerfile),
    );
    cleanupTestDir(firstDir);
    cleanupTestDir(secondDir);
  });

  test("changes when a top-level file changes or is added", () => {
    const tmpDir = createTestDir("docker-test");
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    const scriptPath = path.join(tmpDir, "entrypoint.sh");
    fs.writeFileSync(dockerfilePath, "FROM ubuntu:24.04");
    fs.writeFileSync(scriptPath, "echo original");

    const originalHash = getImageHash(dockerfilePath);
    fs.writeFileSync(scriptPath, "echo modified");
    const modifiedHash = getImageHash(dockerfilePath);
    fs.writeFileSync(path.join(tmpDir, "newscript.sh"), "echo new");

    expect(modifiedHash).not.toBe(originalHash);
    expect(getImageHash(dockerfilePath)).not.toBe(modifiedHash);
    cleanupTestDir(tmpDir);
  });

  test("changes when a nested build-context file changes", () => {
    const tmpDir = createTestDir("docker-test");
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    const nestedDir = path.join(tmpDir, "scripts", "network");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(dockerfilePath, "FROM ubuntu:24.04");
    fs.writeFileSync(path.join(nestedDir, "init.sh"), "echo original");

    const originalHash = getImageHash(dockerfilePath);
    fs.writeFileSync(path.join(nestedDir, "init.sh"), "echo changed");

    expect(getImageHash(dockerfilePath)).not.toBe(originalHash);
    cleanupTestDir(tmpDir);
  });

  test("covers every active nested Docker source", async () => {
    const repoRoot = await getTestRepoRootPath();
    const sourceDirectory = path.join(repoRoot, "docker");
    const tmpDir = createTestDir("docker-active-context");
    fs.cpSync(sourceDirectory, tmpDir, { recursive: true });
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    const originalHash = getImageHash(dockerfilePath);
    const entries = listFilesRecursively(tmpDir);

    expect(entries.map((entry) => entry.relativePath)).toContain(
      "scripts/sandbox-container-tools",
    );
    expect(entries.map((entry) => entry.relativePath)).toContain(
      "configs/profile",
    );

    for (const entry of entries) {
      const filePath = path.join(tmpDir, entry.relativePath);
      fs.writeFileSync(
        filePath,
        Buffer.concat([entry.content, Buffer.from("\nchanged")]),
      );
      expect(getImageHash(dockerfilePath)).not.toBe(originalHash);
      fs.writeFileSync(filePath, entry.content);
    }

    cleanupTestDir(tmpDir);
  });

  test("hashes entries independently of traversal order", () => {
    const entries = [
      {
        relativePath: "Dockerfile",
        kind: "file" as const,
        content: "FROM ubuntu:24.04",
      },
      {
        relativePath: "scripts/init.sh",
        kind: "file" as const,
        content: "echo ready",
      },
    ];

    expect(hashBuildContextEntries(entries)).toBe(
      hashBuildContextEntries([...entries].reverse()),
    );
  });

  test("normalizes path separators before hashing", () => {
    const unixEntries = [
      {
        relativePath: "Dockerfile",
        kind: "file" as const,
        content: "FROM ubuntu:24.04",
      },
      {
        relativePath: "configs/profile",
        kind: "file" as const,
        content: "export READY=1",
      },
    ];
    const windowsEntries = unixEntries.map((entry) => ({
      ...entry,
      relativePath: entry.relativePath.replaceAll("/", "\\"),
    }));

    expect(hashBuildContextEntries(windowsEntries)).toBe(
      hashBuildContextEntries(unixEntries),
    );
  });
});

describe("getImageHash with symbolic links", () => {
  const testDirectories: string[] = [];

  afterEach(() => {
    for (const directory of testDirectories.splice(0)) {
      cleanupTestDir(directory);
    }
  });

  function createBuildContext(): { directory: string; dockerfilePath: string } {
    const directory = createTestDir("docker-symlink-context");
    testDirectories.push(directory);
    const dockerfilePath = path.join(directory, "Dockerfile");
    fs.writeFileSync(dockerfilePath, "FROM ubuntu:24.04");
    return { directory, dockerfilePath };
  }

  test("changes when a symbolic link is retargeted", () => {
    const { directory, dockerfilePath } = createBuildContext();
    fs.writeFileSync(path.join(directory, "first.txt"), "first");
    fs.writeFileSync(path.join(directory, "second.txt"), "second");
    const linkPath = path.join(directory, "input.txt");
    fs.symlinkSync("first.txt", linkPath, "file");

    const originalHash = getImageHash(dockerfilePath);
    fs.rmSync(linkPath);
    fs.symlinkSync("second.txt", linkPath, "file");

    expect(getImageHash(dockerfilePath)).not.toBe(originalHash);
  });

  test("changes when a regular file is replaced by an equivalent symlink", () => {
    const { directory, dockerfilePath } = createBuildContext();
    const inputPath = path.join(directory, "input.txt");
    fs.writeFileSync(path.join(directory, "source.txt"), "target content");
    fs.writeFileSync(inputPath, "source.txt");

    const regularFileHash = getImageHash(dockerfilePath);
    fs.rmSync(inputPath);
    fs.symlinkSync("source.txt", inputPath, "file");

    expect(getImageHash(dockerfilePath)).not.toBe(regularFileHash);
  });

  test("represents a symbolic link by its relative path and target bytes", () => {
    const { directory } = createBuildContext();
    const linkPath = path.join(directory, "configs", "input.txt");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync("../source.txt", linkPath, "file");

    const linkEntry = listFilesRecursively(directory).find(
      (entry) => entry.relativePath === "configs/input.txt",
    );

    expect(linkEntry?.content).toEqual(Buffer.from("../source.txt"));
  });

  test("changes when the linked target is also a build-context file", () => {
    const { directory, dockerfilePath } = createBuildContext();
    const targetPath = path.join(directory, "source.txt");
    fs.writeFileSync(targetPath, "before");
    fs.symlinkSync("source.txt", path.join(directory, "input.txt"), "file");

    const originalHash = getImageHash(dockerfilePath);
    fs.writeFileSync(targetPath, "after");

    expect(getImageHash(dockerfilePath)).not.toBe(originalHash);
  });

  test("does not recursively follow directory symbolic-link cycles", () => {
    const { directory, dockerfilePath } = createBuildContext();
    fs.mkdirSync(path.join(directory, "files"));
    fs.writeFileSync(path.join(directory, "files", "input.txt"), "input");
    fs.symlinkSync("..", path.join(directory, "files", "parent"), "dir");

    const entries = listFilesRecursively(directory);

    expect(getImageHash(dockerfilePath)).toHaveLength(12);
    expect(entries.map((entry) => entry.relativePath)).toContain(
      "files/parent",
    );
    expect(entries.map((entry) => entry.relativePath)).not.toContain(
      "files/parent/files/parent",
    );
  });
});
