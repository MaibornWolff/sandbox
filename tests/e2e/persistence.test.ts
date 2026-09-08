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
  projectDir = await createTempProject("persistence");
  await writeProjectFile(
    projectDir,
    ".sandbox/config.toml",
    'persist_paths = [{ path = "~/.e2e-state" }]\n',
  );
  sb = createSandbox({
    cwd: projectDir,
    env: { XDG_DATA_HOME: `${projectDir}/data` },
  });
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

describe("persistent paths", () => {
  test("preserves bind-mounted data across container recreation", async () => {
    const written = await sb.run(
      "sh",
      "-c",
      "mkdir -p ~/.e2e-state && printf persisted > ~/.e2e-state/value",
    );
    expect(written.exitCode).toBe(0);

    const stopped = await sb.stop();
    expect(stopped.exitCode).toBe(0);

    const restored = await sb.run("cat", "/home/sandbox/.e2e-state/value");
    expect(restored.exitCode).toBe(0);
    expect(restored.stdout.trim()).toBe("persisted");
  }, 120_000);
});
