# Repository Test Harnesses

## Application harnesses

The host application harness exposes a real CLI and shared terminal interaction:

```ts
await using app = await setupSandboxAppTest()
await app.project.givenConfig({ allowNetwork: [] })
const result = await app.cli.run("config")
expect(result.exitCode).toBe(0)
```

Use the owner-local fixture beside the behavior under test for imports and complete examples.
`givenConfig()` writes real TOML and a matching trust record.
Later edits invalidate trust as they do in production.

The container-tools harness uses the same application graph for utility dispatch and the PID 1 route.
Its fixture owns the filesystem, signals, process world, network world, clock, and cleanup.

## Isolation

- Own temporary files through `createTestDir()`, `cleanupTestDir()`, and scoped disposal.
- Use `await using` for harness cleanup and settle asynchronous work before scope exit.
- Use deterministic scoped clocks rather than global fake timers.
- Use explicit platform fixtures rather than branching or skipping based on the host platform.
- Avoid `mock.module()` because it interferes with parallel tests.
- Use the real filesystem under a unique test root.
- Drive the shared application terminal through `app.tui`, with bounded waits.
- Keep the process environment, working directory, console, and process streams unchanged. Supply values through the fixture instead.
- Use stateful external-system fixtures and assert observable outcomes.
- Keep generic technical primitives separate from thin scenario-specific fixtures.
