# E2E Tests

E2E tests verify behavior across a real container boundary. They are not part of `bun check`. Follow `README.md` in this folder for prerequisites and runtime selection.

## When to Write

- Add E2E tests when a feature changes behavior that only a real container runtime can show.
- Add a regression test at this level when reproducing a bug requires a real container runtime.

## Running

```bash
bun run test:e2e                                   # core boundary suite
bun run test:e2e:extended                          # explicit PHP/Devbox qualification
bun test tests/e2e/network.test.ts                 # single file
SANDBOX_BIN=/path/to/sandbox bun test --timeout 30000 tests/e2e/ # custom binary
```

For container behavior changes, run E2E tests before submitting changes. They also run in CI on `main`.

- Use focused E2E tests during debugging and reserve full-suite runs for initial and final verification.

## Writing Tests

Use a dedicated temp project per test file to isolate containers:

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

- Verify DNS-provider logic with deterministic tests and use the configured DNS mode for general network E2E coverage.
- Keep general E2E tests runnable on Linux with the CI-selected container runtime.
- Keep extended tool-installation tests opt-in and excluded from normal runners and CI.
- Use E2E tests for published ports and bind-mount enforcement, not exit-code orchestration with a fake runtime.
- Do not use the default `sandbox` instance from `utils/sandbox.js`. Always create a dedicated one with `createSandbox({ cwd: projectDir })`.
- Call `cleanupProject()` in `afterAll`. It calls `sb.stop()` and removes the temp dir.
- Do not run against the real project directory. This prevents accidentally stopping development containers.
- Inside Sandbox, run container-backed tests through `sandbox escape` when permitted and select the configured runtime explicitly. Ask for manual testing only when host execution is unavailable.
- Before replacing a failing external fixture, find the cause. Use a replacement only if it exercises the same behavior.
