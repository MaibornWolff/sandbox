import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

const MISE_CONFIG = '[tools]\nyq = "latest"\n';

let projectDir: string;
let sb: SandboxInstance;

beforeAll(async () => {
  projectDir = await createTempProject("mise");

  // Write .mise.toml so init --project auto-detects it and copies to build context
  await writeProjectFile(projectDir, ".mise.toml", MISE_CONFIG);

  sb = createSandbox({ cwd: projectDir });

  // Use sandbox init --project --tools to generate the Dockerfile non-interactively
  const initResult = await sb.exec(
    ["init", "--project", "--tools", "mise-env"],
    {
      timeoutSeconds: 60,
    },
  );
  expect(initResult.exitCode).toBe(0);
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

describe("init-mise", () => {
  test("builds project image", async () => {
    const result = await sb.build();
    expect(result.exitCode).toBe(0);
  }, 120_000);

  test("mise is installed", async () => {
    const { stdout, exitCode } = await sb.run("mise", "--version");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/[0-9]+\.[0-9]+/);
  });

  test("base image provides jq for agent workflows", async () => {
    const { stdout, exitCode } = await sb.run(
      "jq",
      "--null-input",
      "--raw-output",
      '{"tool":"available"} | .tool',
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("available");
  });

  test("project tool installed from .mise.toml", async () => {
    const { stdout, exitCode } = await sb.run("yq", "--version");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/[0-9]/);
  });

  test("mise lists installed tools", async () => {
    const { stdout, exitCode } = await sb.run("mise", "ls");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("yq");
  });

  test("mise shims on PATH", async () => {
    const { stdout, exitCode } = await sb.run("sh", "-c", "echo $PATH");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/mise|\.local/);
  });

  test("mise doctor reports healthy", async () => {
    const { exitCode } = await sb.run("mise", "doctor");
    expect(exitCode).toBe(0);
  });

  test("mise env activates", async () => {
    const { exitCode } = await sb.run("mise", "env");
    expect(exitCode).toBe(0);
  });
});
