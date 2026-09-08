import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createProcessTestHarness,
  type ProcessTestHarness,
} from "#platform/process/__test__/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { createGitFixture, type GitFixture } from "./__test__/index.js";
import {
  getExternalWorktreePath,
  getGitRootPath,
  getRepoRootPath,
} from "./git.js";

describe("Git facade", () => {
  let root: string;
  let processes: ProcessTestHarness;
  let git: GitFixture;

  beforeEach(() => {
    root = createTestDir("git-facade");
    processes = createProcessTestHarness();
    git = createGitFixture(processes);
  });

  afterEach(() => cleanupTestDir(root));

  function scoped<T>(operation: () => T): T {
    git.prepare();
    return processes.run(operation);
  }

  test("constructs Git commands and resolves a repository root", async () => {
    const repositoryRoot = path.join(root, "repository");
    const queriedPath = path.join(repositoryRoot, "src");
    fs.mkdirSync(queriedPath, { recursive: true });
    git.givenRepository({ root: repositoryRoot, queriedPath });

    const result = await scoped(() => getRepoRootPath(queriedPath));

    expect(result).toBe(repositoryRoot);
    expect(git.operations().map((operation) => operation.args)).toEqual([
      [
        "-C",
        queriedPath,
        "rev-parse",
        "--show-toplevel",
        "--path-format=absolute",
        "--git-common-dir",
      ],
    ]);
  });

  test("resolves the repository root from legacy Git multiline output", async () => {
    const repositoryRoot = path.join(root, "repository");
    fs.mkdirSync(repositoryRoot);
    processes
      .expectStart({
        match: {
          command: "git",
          args: [
            "-C",
            repositoryRoot,
            "rev-parse",
            "--show-toplevel",
            "--path-format=absolute",
            "--git-common-dir",
          ],
        },
      })
      .resolveResult({
        exitCode: 0,
        stdout: `${repositoryRoot}\n--path-format=absolute\n.git\n`,
        stderr: "",
      });

    expect(await scoped(() => getRepoRootPath(repositoryRoot))).toBe(
      repositoryRoot,
    );
  });

  test("returns null and preserves failed process observations outside Git", async () => {
    const projectPath = path.join(root, "plain");
    fs.mkdirSync(projectPath);
    git.givenNoRepository(projectPath);

    expect(await scoped(() => getGitRootPath(projectPath))).toBeNull();
    expect(processes.requests[0]?.command).toBe("git");
  });

  test("prefers a nested sandbox marker", async () => {
    const repositoryRoot = path.join(root, "repository");
    const projectPath = path.join(repositoryRoot, "nested");
    fs.mkdirSync(path.join(projectPath, ".sandbox"), { recursive: true });
    git.givenRepository({ root: repositoryRoot, queriedPath: projectPath });

    expect(await scoped(() => getRepoRootPath(projectPath))).toBe(projectPath);
  });

  test("prefers a sandbox marker above the Git repository", async () => {
    const projectRoot = path.join(root, "project");
    const repositoryRoot = path.join(projectRoot, "repos", "repository");
    fs.mkdirSync(path.join(projectRoot, ".sandbox"), { recursive: true });
    fs.mkdirSync(repositoryRoot, { recursive: true });
    git.givenRepository({ root: repositoryRoot, queriedPath: repositoryRoot });

    expect(await scoped(() => getRepoRootPath(repositoryRoot))).toBe(
      projectRoot,
    );
  });

  test("ignores a sandbox marker that is not a directory", async () => {
    const projectRoot = path.join(root, "project");
    const repositoryRoot = path.join(projectRoot, "repository");
    fs.mkdirSync(repositoryRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".sandbox"), "");
    git.givenRepository({ root: repositoryRoot, queriedPath: repositoryRoot });

    expect(await scoped(() => getRepoRootPath(repositoryRoot))).toBe(
      repositoryRoot,
    );
  });

  test("returns the external worktree but not an internal worktree", async () => {
    const repositoryRoot = path.join(root, "repository");
    const external = path.join(root, "worktree");
    fs.mkdirSync(repositoryRoot);
    fs.mkdirSync(external);
    git.givenRepository({
      root: repositoryRoot,
      queriedPath: external,
      worktreeRoot: external,
    });
    expect(await scoped(() => getExternalWorktreePath(external))).toBe(
      external,
    );

    const internal = path.join(repositoryRoot, "worktrees", "feature");
    fs.mkdirSync(internal, { recursive: true });
    git.givenRepository({
      root: repositoryRoot,
      queriedPath: internal,
      worktreeRoot: internal,
    });
    expect(await scoped(() => getExternalWorktreePath(internal))).toBeNull();
  });

  test("uses cached roots without executing Git", async () => {
    const repositoryRoot = path.join(root, "repository");
    const worktreeRoot = path.join(root, "worktree");
    const result = await scoped(() =>
      getExternalWorktreePath(worktreeRoot, {
        mainRepoRoot: repositoryRoot,
        worktreeRoot,
      }),
    );
    expect(result).toBe(worktreeRoot);
    expect(processes.requests).toHaveLength(0);
  });
});
