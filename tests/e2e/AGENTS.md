# E2E Tests

E2E tests verify behavior across a real container boundary. They are not part of `bun check`. Follow `README.md` in this folder for prerequisites and runtime selection.

## When to Write

- You MUST write E2E tests for every new feature.
- You SHOULD add a regression test for bug fixes that affect container behavior.

## Running

```bash
bun run test:e2e                                   # core boundary suite
bun run test:e2e:extended                          # explicit PHP/Devbox qualification
bun test tests/e2e/network.test.ts                 # single file
SANDBOX_BIN=/path/to/sandbox bun test --timeout 30000 tests/e2e/ # custom binary
```

You SHOULD run E2E tests before submitting changes. They run automatically in CI on `main`.

- You MUST use focused E2E tests during debugging and reserve full-suite runs for initial and final verification.

## Writing Tests

You MUST use a dedicated temp project per test file to isolate containers:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type SandboxInstance, createSandbox } from "./utils/sandbox.js";
import { cleanupProject, createTempProject, writeProjectFile } from "./utils/project.js";

let projectDir: string;
let sb: SandboxInstance;

beforeAll(async () => {
  projectDir = await createTempProject("my-feature");
  await writeProjectFile(projectDir, ".sandbox/config.toml", `allow_network = ["example.com"]`);
  sb = createSandbox({ cwd: projectDir });
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
});

test("my feature works", async () => {
  const { stdout, exitCode } = await sb.run("my-command");
  expect(exitCode).toBe(0);
  expect(stdout).toContain("expected output");
});
```

## Rules

- You MUST verify DNS-provider logic with deterministic tests and use the configured DNS mode for general network E2E coverage.
- You MUST keep general E2E tests runnable on Linux with the CI-selected container runtime.
- You MUST keep extended tool-installation tests opt-in and excluded from normal runners and CI.
- You MUST only use E2E tests for behavior that requires a real container runtime. Examples: published ports and bind-mount enforcement. Negative example: exit-code orchestration with a fake runtime.
- You MUST NOT use the default `sandbox` instance from `utils/sandbox.js`. Always create a dedicated one with `createSandbox({ cwd: projectDir })`.
- You MUST call `cleanupProject()` in `afterAll`. It calls `sb.stop()` and removes the temp dir.
- You MUST NOT run against the real project directory. This prevents accidentally stopping development containers.
