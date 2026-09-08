import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

let projectDir: string;
let realDir: string;
let linkDir: string;
let sb: SandboxInstance;

beforeAll(async () => {
  projectDir = await createTempProject("mounts-symlink");

  // Create a real directory with a marker file inside the project
  realDir = join(projectDir, "real-data");
  linkDir = join(projectDir, "link-data");
  await mkdir(realDir, { recursive: true });
  writeFileSync(join(realDir, "marker.txt"), "symlink-resolved");

  symlinkSync(realDir, linkDir);

  // Use the absolute symlink path - project config now allows absolute paths
  // within the project directory, and the resolver will pass the real path
  // to Docker runtimes on macOS
  await writeProjectFile(
    projectDir,
    ".sandbox/config.toml",
    `mounts = ["${linkDir}:/mnt/data:ro"]\n`,
  );

  sb = createSandbox({ cwd: projectDir });
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

describe("mounts-symlink", () => {
  test("starts container with symlinked mount", async () => {
    const result = await sb.run("true");
    expect(result.exitCode).toBe(0);
  }, 120_000);

  test("symlinked mount directory is accessible inside container", async () => {
    const { stdout, exitCode } = await sb.run("cat", "/mnt/data/marker.txt");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("symlink-resolved");
  });

  test("symlinked mount is read-only inside container", async () => {
    const { exitCode } = await sb.run(
      "sh",
      "-c",
      "echo denied > /mnt/data/readonly-check.txt 2>&1",
    );
    expect(exitCode).not.toBe(0);
  });
});
