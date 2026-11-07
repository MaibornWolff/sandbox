import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

let projectDir: string;
let sb: SandboxInstance;
let generated: string;

beforeAll(async () => {
  projectDir = await createTempProject("build-secrets");
  sb = createSandbox({ cwd: projectDir });
  const init = await sb.exec(["init", "--project", "--tools", "node"]);
  expect(init.exitCode, init.stderr).toBe(0);
  generated = await readFile(
    join(projectDir, ".sandbox/docker/Dockerfile"),
    "utf8",
  );
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
}, 30_000);

for (const token of ["", "fixture-build-token"]) {
  test(`builds with ${token ? "a" : "no"} GitHub secret without persisting it`, async () => {
    await writeProjectFile(
      projectDir,
      ".sandbox/docker/Dockerfile",
      `${generated.replace(
        "mise use -g node@lts",
        `test "$(id -un)" = sandbox && test "\${GITHUB_TOKEN:-}" = "${token}"`,
      )}\nRUN test -z "\${GITHUB_TOKEN:-}" && test ! -e /run/secrets/GITHUB_TOKEN\n`,
    );
    const build = await sb.exec(["build"], {
      timeoutSeconds: 300,
      env: { GITHUB_TOKEN: token || undefined },
    });
    expect(build.exitCode, build.stderr).toBe(0);
  }, 360_000);
}
