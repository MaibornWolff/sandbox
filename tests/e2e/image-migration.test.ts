import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

let projectDir: string;
let sb: SandboxInstance;

beforeAll(async () => {
  projectDir = await createTempProject("image-migration-cleanup");
  await writeProjectFile(
    projectDir,
    ".sandbox/docker/Dockerfile",
    "FROM sandbox--base:latest\nRUN printf migrated-layer > /opt/migration-marker\n",
  );
  sb = createSandbox({ cwd: projectDir, timeoutSeconds: 60 });
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

describe("image migration and runtime cleanup", () => {
  test("migrates a legacy project layer and builds the resulting image", async () => {
    const built = await sb.build();
    expect(built.exitCode).toBe(0);

    const marker = await sb.run("cat", "/opt/migration-marker");
    expect(marker.exitCode).toBe(0);
    expect(marker.stdout).toContain("migrated-layer");
  }, 300_000);
});
