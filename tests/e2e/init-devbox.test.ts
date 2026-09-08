import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

// Version the launcher falls back to when it cannot reach its release host.
const OFFLINE_FALLBACK_VERSION = "0.8.3";
const DEVBOX_JSON = '{"packages":[]}\n';
const DEVBOX_LOCK = '{"lockfile_version":"1"}\n';

let projectDir: string;
let sb: SandboxInstance;

beforeAll(async () => {
  projectDir = await createTempProject("devbox");
  await writeProjectFile(projectDir, "devbox.json", DEVBOX_JSON);
  await writeProjectFile(projectDir, "devbox.lock", DEVBOX_LOCK);

  sb = createSandbox({ cwd: projectDir });

  const initResult = await sb.exec(["init", "--project", "--tools", "devbox"], {
    timeoutSeconds: 60,
  });
  expect(initResult.exitCode).toBe(0);
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

describe("init-devbox", () => {
  test("builds project image", async () => {
    const result = await sb.build(600);
    expect(result.exitCode).toBe(0);
  }, 900_000);

  test("nix is on PATH in a bash login shell", async () => {
    const { stdout, exitCode } = await sb.exec(
      ["run", "--", "bash", "-lc", "command -v nix"],
      { timeoutSeconds: 120 },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("/nix/");
  }, 150_000);

  test("devbox launcher resolves its version, not the offline fallback", async () => {
    // Blocked release hosts pin the launcher to a version that cannot parse
    // `nix profile list --json`, breaking every shellenv and run.
    const { stdout, exitCode } = await sb.exec(
      ["run", "--", "devbox", "version"],
      { timeoutSeconds: 120 },
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).not.toBe(OFFLINE_FALLBACK_VERSION);
    expect(stdout.trim()).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
  });
});
