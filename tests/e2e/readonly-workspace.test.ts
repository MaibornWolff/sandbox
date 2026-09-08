import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

let projectDir: string;
let sb: SandboxInstance;

beforeAll(async () => {
  projectDir = await createTempProject("readonly-workspace");
  await writeProjectFile(
    projectDir,
    ".sandbox/config.toml",
    "readonly = true\n",
  );
  await writeProjectFile(projectDir, "workspace-marker.txt", "unchanged");
  sb = createSandbox({ cwd: projectDir });
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

describe("read-only workspace", () => {
  test("allows reads but rejects writes through the Docker bind mount", async () => {
    const readResult = await sb.run("cat", "workspace-marker.txt");
    expect(readResult.exitCode).toBe(0);
    expect(readResult.stdout.trim()).toBe("unchanged");

    const writeResult = await sb.run(
      "sh",
      "-c",
      "printf changed > workspace-marker.txt",
    );
    expect(writeResult.exitCode).not.toBe(0);
    expect(await readFile(`${projectDir}/workspace-marker.txt`, "utf8")).toBe(
      "unchanged",
    );
  }, 120_000);
});
