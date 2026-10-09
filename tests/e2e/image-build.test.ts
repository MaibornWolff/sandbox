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
    "/usr/bin/node",
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
