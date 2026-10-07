import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

let project: string;
let sandbox: SandboxInstance;

beforeAll(async () => {
  project = await createTempProject("connection-lifecycle");
  await writeProjectFile(
    project,
    ".sandbox/docker/Dockerfile",
    `FROM sandbox-base:latest
ENV SANDBOX_IDLE_TIMEOUT_SECONDS=1
RUN mv /usr/bin/Xvfb /usr/bin/Xvfb-real \\
  && printf '%s\\n' '#!/bin/sh' 'sleep 3' 'exec /usr/bin/Xvfb-real "$@"' > /usr/bin/Xvfb \\
  && chmod +x /usr/bin/Xvfb
`,
  );
  sandbox = createSandbox({ cwd: project });
  const build = await sandbox.build();
  expect(build.exitCode, build.stderr).toBe(0);
});

afterAll(async () => {
  await cleanupProject(project, sandbox);
});

test("keeps a reused container alive while concurrent sessions connect", async () => {
  const warmup = sandbox.start([
    "run",
    "--",
    "sh",
    "-c",
    "printf 'warmup-ready\\n'; hostname; while [ ! -f warmup-release ]; do sleep 0.05; done",
  ]);
  await warmup.waitForOutput("warmup-ready");
  const command = [
    "--verbose",
    "run",
    "--",
    "sh",
    "-c",
    "printf 'connection-ready\\n'; hostname; while [ ! -f connection-release ]; do sleep 0.05; done",
  ];
  const first = sandbox.start(command);
  const second = sandbox.start(command);
  await Promise.all([
    first.waitForOutput("Starting private clipboard session"),
    second.waitForOutput("Starting private clipboard session"),
  ]);
  await writeProjectFile(project, "warmup-release", "ready");
  const warmupResult = await warmup.result;
  expect(warmupResult.exitCode, warmupResult.stderr).toBe(0);
  const initialHostname = warmupResult.stdout.trim().split("\n").at(-1);
  await Promise.all([
    first.waitForOutput("connection-ready"),
    second.waitForOutput("connection-ready"),
  ]);
  await writeProjectFile(project, "connection-release", "ready");
  const results = await Promise.all([first.result, second.result]);
  for (const result of results) {
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n").at(-1)).toBe(initialHostname);
    expect(result.stderr).not.toContain("Private clipboard proxy stopped");
    expect(result.stderr).not.toContain("Clipboard is unavailable");
  }
});
