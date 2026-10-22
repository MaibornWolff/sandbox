# Testing

Read this guide when adding or changing tests.
The local gate uses [Bun](https://bun.sh/docs).
See [Contributing](../CONTRIBUTING.md) for local setup.

## Run checks

```bash
bun check
```

This is the normal validation command.
For documentation-only changes, check links and `git diff --check` instead.

Run `bun run test:shell` when changing container shell scripts.
It needs `sh`, `bash`, and `zsh` on the host and is separate from the cross-platform gate.

Run `bun run test:e2e` for real container boundaries.
Inside Sandbox, use the permitted host escape and select the configured runtime explicitly.
Read [E2E guidance](../tests/e2e/AGENTS.md) before changing those tests.

## Choose the test level

Use the lowest level that proves the behavior:

- Pure tests for parsing, normalization, state transitions, and formatting.
- Component tests for an owned contract.
- Application harnesses for workflows crossing components.
- Real-container tests for terminal descriptors, signals, PID 1, mounts, firewall setup, and runtime behavior.

Keep product commands, parsers, configuration, prompts, and orchestration real.
Replace only external technical boundaries.
Do not start [Docker](https://docs.docker.com/engine/) just to inspect generated arguments.

## Use the application harnesses

The host application harness exposes a real CLI and shared terminal interaction:

```ts
await using app = await setupSandboxAppTest();
await app.project.givenConfig({ allowNetwork: [] });
const execution = app.cli.run("config");
const result = await execution;
expect(result.exitCode).toBe(0);
```

Use the owner-local fixture beside the behavior under test for imports and examples.
`givenConfig()` writes real TOML and a matching trust record.
Later edits invalidate trust as they do in production.

The container-tools harness uses the same application graph for utility dispatch and the PID 1 route.
Its fixture owns the filesystem, signals, process world, network world, clock, and cleanup.

## Keep tests independent

- Own temporary files through `createTestDir()`, `cleanupTestDir()`, and scoped disposal.
- Use `await using` for harness cleanup and settle asynchronous work before scope exit.
- Use deterministic scoped clocks, not global fake timers.
- Use the real filesystem under a unique test root.
- Drive the global application terminal through `app.tui`, with bounded waits.
- Do not mutate the process environment, working directory, console, or process streams.
- Use stateful external-system fixtures and assert observable outcomes.
- Keep generic technical primitives separate from thin scenario-specific fixtures.

## Coverage

`bun check` runs the coverage gate after other validation tasks.
The gate enforces 95% aggregate line coverage from LCOV.

Add missing user, failure, contract, and edge behavior.
Do not add source-text assertions, impossible states, or redundant tests only to raise a percentage.
If code appears dead, investigate its callers and history before removing it.
