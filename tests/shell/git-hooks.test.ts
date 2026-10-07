import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { getRepoRootPath } from "#platform/git/index.js";

for (const exitCode of [0, 7]) {
  test(`pre-commit runs the full check and preserves exit code ${exitCode}`, async () => {
    const result = spawnSync(
      "sh",
      [
        "-c",
        `bun() { printf 'bun %s\\n' "$*"; return ${exitCode}; }
         git() { printf 'git %s\\n' "$*"; }
         . .husky/pre-commit`,
      ],
      { cwd: await getRepoRootPath(process.cwd()), encoding: "utf8" },
    );

    expect(result.error).toBeUndefined();
    expect(result.stdout.trim()).toBe("bun check");
    expect(result.status).toBe(exitCode);
  });
}
