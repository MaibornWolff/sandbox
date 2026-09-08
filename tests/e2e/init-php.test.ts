import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanupProject, createTempProject } from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

let projectDir: string;
let sb: SandboxInstance;

beforeAll(async () => {
  projectDir = await createTempProject("php");

  sb = createSandbox({ cwd: projectDir });

  // Use sandbox init --project --tools to generate the Dockerfile non-interactively
  const initResult = await sb.exec(
    ["init", "--project", "--tools", "php,composer"],
    {
      timeoutSeconds: 60,
    },
  );
  expect(initResult.exitCode).toBe(0);
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

describe("init-php", () => {
  test("builds project image", async () => {
    const result = await sb.build();
    expect(result.exitCode).toBe(0);
  }, 300_000);

  test("php 8.5 is installed", async () => {
    const { stdout, exitCode } = await sb.run("php", "--version");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/PHP 8\.5\./);
  });

  test("standard extensions are installed", async () => {
    const { stdout, exitCode } = await sb.run("php", "-m");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("curl");
    expect(stdout).toContain("mbstring");
    expect(stdout).toContain("zip");
  });

  test("composer is installed", async () => {
    const { stdout, exitCode } = await sb.run("composer", "--version");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Composer version/);
  });
});
