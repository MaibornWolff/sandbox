import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

let projectDir: string;
let sb: SandboxInstance;
const marker = randomUUID();

beforeAll(async () => {
  projectDir = await createTempProject("image-build");
  await writeProjectFile(
    projectDir,
    ".sandbox/docker/Dockerfile",
    `FROM sandbox-base:latest\nENV SANDBOX_IMAGE_TEST_MARKER=${marker}\n`,
  );
  sb = createSandbox({ cwd: projectDir });
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
}, 30_000);

test("builds and executes a project image with working base tools", async () => {
  const first = await sb.build();
  expect(first.exitCode, first.stderr).toBe(0);
  const result = await sb.run(
    "/usr/local/bin/node",
    "-e",
    "console.log(process.env.SANDBOX_IMAGE_TEST_MARKER)",
  );
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(marker);
  const jq = await sb.run(
    "jq",
    "--null-input",
    "--raw-output",
    '{"tool":"available"} | .tool',
  );
  expect(jq.exitCode, jq.stderr).toBe(0);
  expect(jq.stdout.trim()).toBe("available");
}, 600_000);

test("provides a patched root-owned Node runtime for the sandbox user", async () => {
  const result = await sb.run(
    "/usr/local/bin/node",
    "--input-type=module",
    "-e",
    `
import { statSync } from 'node:fs';
import { userInfo } from 'node:os';
const binary = statSync(process.execPath);
console.log(JSON.stringify({
  version: process.versions.node,
  executable: process.execPath,
  owner: binary.uid,
  writableByOthers: (binary.mode & 0o022) !== 0,
  user: userInfo().username,
  uid: process.getuid(),
}));
`,
  );
  expect(result.exitCode, result.stderr).toBe(0);
  const runtime = JSON.parse(result.stdout.trim());
  expect(runtime).toMatchObject({
    executable: "/usr/local/bin/node",
    owner: 0,
    writableByOthers: false,
    user: "sandbox",
  });
  expect(runtime.uid).toBeGreaterThan(0);
  expect(Bun.semver.satisfies(runtime.version, "^24.22.1")).toBe(true);
}, 60_000);
