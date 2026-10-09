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
  expect((await sb.build()).exitCode).toBe(0);
}, 360_000);

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

describe("init-mise", () => {
  test("installs and executes the project tool from .mise.toml", async () => {
    const inventory = await sb.run("mise", "ls");
    expect(inventory.exitCode).toBe(0);
    expect(inventory.stdout).toContain("yq");
    const tool = await sb.run("yq", "--version");
    expect(tool.exitCode).toBe(0);
    expect(tool.stdout).toMatch(/[0-9]/);
  });
});
