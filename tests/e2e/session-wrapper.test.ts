import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import {
  assertSandboxSuccess,
  createSandbox,
  type SandboxInstance,
} from "./utils/sandbox.js";

let projectDir: string;
let sb: SandboxInstance;

beforeAll(async () => {
  projectDir = await createTempProject("session-wrapper");
  await writeProjectFile(
    projectDir,
    ".sandbox/config.toml",
    '[session]\ncommand_wrapper = ["./wrapper", "argument with spaces"]\n',
  );
  await writeProjectFile(
    projectDir,
    "wrapper",
    '#!/bin/sh\nprintf "wrapper:%s\\n" "$1"\nshift\nexec "$@"\n',
  );
  await chmod(join(projectDir, "wrapper"), 0o755);
  sb = createSandbox({ cwd: projectDir, timeoutSeconds: 120 });
  assertSandboxSuccess(await sb.build());
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

test("runs a relative wrapper with separate arguments and preserves the child exit code", async () => {
  const result = await sb.exec([
    "--no-build",
    "run",
    "--",
    "sh",
    "-c",
    "printf 'child:%s\\n' \"$1\"; exit 37",
    "sh",
    "value with spaces",
  ]);
  expect(result.exitCode).toBe(37);
  expect(result.stdout).toContain("wrapper:argument with spaces");
  expect(result.stdout).toContain("child:value with spaces");
});

test.each([
  { name: "command through PATH", wrapper: "env" },
  { name: "absolute path", wrapper: "/usr/bin/env" },
])("resolves a wrapper by $name", async ({ wrapper }) => {
  await writeProjectFile(
    projectDir,
    ".sandbox/config.toml",
    `[session]\ncommand_wrapper = ["${wrapper}", "--"]\n`,
  );
  const result = await sb.exec(["--no-build", "run", "printf", "resolved"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("resolved");
});

test("identifies a wrapper that cannot be executed", async () => {
  await writeProjectFile(
    projectDir,
    ".sandbox/config.toml",
    '[session]\ncommand_wrapper = ["./missing-wrapper"]\n',
  );
  const result = await sb.exec(["--no-build", "run", "true"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("missing-wrapper");
});
