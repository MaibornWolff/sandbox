import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

beforeAll(async () => {
  projectDir = await createTempProject("javascript");
  await writeProjectFile(
    projectDir,
    ".mise.toml",
    '[tools]\nnode = "26"\npnpm = "10.15.0"\n',
  );
  sb = createSandbox({ cwd: projectDir });
  const init = await sb.exec(
    ["init", "--project", "--tools", "node,pnpm,mise-env"],
    { timeoutSeconds: 60 },
  );
  expect(init.exitCode, init.stderr).toBe(0);

  const dockerfilePath = ".sandbox/docker/Dockerfile";
  const generated = await readFile(join(projectDir, dockerfilePath), "utf8");
  await writeProjectFile(
    projectDir,
    dockerfilePath,
    generated
      .replace("node@lts", "node@26")
      .replace(
        "USER sandbox",
        "USER root\nRUN rm -f /usr/local/bin/corepack /usr/bin/corepack\nUSER sandbox",
      ),
  );
  const build = await sb.build(600);
  expect(build.exitCode, build.stderr).toBe(0);
}, 660_000);

afterAll(async () => {
  await cleanupProject(projectDir, sb);
}, 30_000);

describe("init-javascript", () => {
  test("runs Node 26 and the default pnpm as sandbox without Corepack", async () => {
    const result = await sb.run(
      "bash",
      "-c",
      'cd "$HOME" && test "$(id -un)" = sandbox && ! command -v corepack && node --version && pnpm --version',
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^v26\.\d+\.\d+\n\d+\.\d+\.\d+$/);
  });

  test("uses the project's explicit pnpm version for direct commands", async () => {
    const result = await sb.run("pnpm", "--version");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("10.15.0");
  });
});
