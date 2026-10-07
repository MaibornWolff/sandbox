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

test("builds a missing project image and reuses the existing image", async () => {
  const first = await sb.build();
  expect(first.exitCode, first.stderr).toBe(0);
  const second = await sb.build();
  expect(second.exitCode, second.stderr).toBe(0);
  const result = await sb.run(
    "/usr/bin/node",
    "-e",
    "console.log(process.env.SANDBOX_IMAGE_TEST_MARKER)",
  );
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(marker);
}, 600_000);
