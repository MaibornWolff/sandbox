import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import path from "node:path";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { gitCommand } from "./release-command.js";

function createRepositories() {
  const root = createTestDir("release-command");
  const target = path.join(root, "target");
  const hookRepository = path.join(root, "hook");
  for (const repository of [target, hookRepository]) {
    gitCommand(["init", "--quiet", repository], root);
  }
  return {
    target: realpathSync(target),
    hookGitDirectory: path.join(hookRepository, ".git"),
    [Symbol.dispose]() {
      cleanupTestDir(root);
    },
  };
}

test("runs git in the requested repository when a git hook exports repository variables", () => {
  using repositories = createRepositories();
  const script = `
    const { gitCommand } = await import(${JSON.stringify(path.join(import.meta.dir, "release-command.ts"))});
    process.stdout.write(gitCommand(["rev-parse", "--absolute-git-dir"], process.argv[1]));
  `;

  const result = Bun.spawnSync(
    [process.execPath, "-e", script, repositories.target],
    {
      env: {
        ...process.env,
        GIT_DIR: repositories.hookGitDirectory,
        GIT_INDEX_FILE: path.join(repositories.hookGitDirectory, "index"),
      },
    },
  );

  expect(result.stderr.toString()).not.toContain("failed");
  expect(result.stdout.toString()).toBe(path.join(repositories.target, ".git"));
});
