import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanupProject, createTempProject } from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

let projectDir: string;
let sb: SandboxInstance;

beforeAll(async () => {
  projectDir = await createTempProject("stdin");
  sb = createSandbox({ cwd: projectDir });
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

describe("stdin forwarding", () => {
  test("forwards piped stdin to sandbox run commands", async () => {
    const result = await sb.exec(["run", "--", "cat"], { stdin: "123\n" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("123");
  });

  test("passes the host terminal descriptors to Docker for interactive exec", async () => {
    const result = await sb.execTerminal([
      "run",
      "--",
      "sh",
      "-c",
      "test -t 0 && test -t 1 && printf terminal-attached",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("terminal-attached");
    expect(result.stdout + result.stderr).not.toContain(
      "the input device is not a TTY",
    );
  }, 60_000);
});
