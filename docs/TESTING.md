# Testing

## Select the Smallest Sufficient Test

- Use a pure test for parsing, sorting, normalization, argument construction, state transitions, or formatting.
- Use a component test for a platform or module contract.
- Use the application harness for a workflow that crosses component boundaries.
- Use a Docker-backed end-to-end (E2E) test only for behavior that requires a real container boundary.
- Keep product commands, use cases, configuration behavior, parsers, prompts, and orchestration real.

A terminal device (TTY) boundary requires a real pseudo-terminal. Process identifier 1 (PID 1) behavior requires a real container process.

The checked-in [host command behavior matrix](./agents/host-command-behavior-matrix.md) and [container-tools command behavior matrix](./agents/container-tools-command-behavior-matrix.md) map each real route to its application and focused behavior coverage.

## Host Application Harness

Use `await using` to settle pending prompts and executions. It also removes temporary roots after a test failure:

```ts
test("adds a blocked domain to project config", async () => {
  await using app = await setupSandboxAppTest();
  await app.project.givenConfig({ allowNetwork: [] });
  const container = app.project.givenContainer({ state: "running" });
  container.network.block("api.example.com", 443);

  const execution = app.cli.run("network", "allow");
  await app.tui.waitForText("Select domains to allow:");
  await app.tui.user.type("/api.example.com");
  await app.tui.user.enter();
  await app.tui.user.space();
  await app.tui.user.enter();
  await app.tui.waitForText("Add to which config?");
  await app.tui.user.down();
  await app.tui.user.enter();

  expect((await execution).exitCode).toBe(0);
  expect((await app.project.readConfig()).allowNetwork).toEqual([
    { host: "api.example.com", ports: [443], wildcard: false },
  ]);
});
```

`givenConfig()` writes real TOML and a matching isolated trust record. Editing the project config afterward makes it untrusted, matching production behavior.

## Container-Tools Application Harness

Test utility dispatch and the real PID 1 route through the same scoped application graph:

```ts
test("stops PID 1 cleanly after SIGTERM", async () => {
  await using app = await setupContainerToolsAppTest();
  const execution = app.entrypoint.start();

  await app.entrypoint.waitForReady();
  app.signals.send("SIGTERM");

  expect((await execution).exitCode).toBe(143);
  expect(app.children.pending()).toBe(0);
  expect(app.signals.subscriptions()).toBe(0);
});
```

The harness owns one rooted container filesystem, terminal, deterministic clock, stateful process adapter, real process manager, TCP world, signal subscriptions, children, and cleanup lifecycle per application.

## Scoped Boundaries and Shared Primitives

Each harness execution enters its own `runWithDependencies()` callback. Bind only technical boundaries owned by the application graph:

- immutable host or sandbox environment values
- terminal streams and abort signal
- clock, process, and TCP services
- host logger and container runtime provider
- owner-local component fixtures

Shared test primitives must remain generic and live beside their owning contract. Examples include terminal byte/screen interaction, deterministic clock advancement, process children/results/signals, managed TCP endpoints, stateful runtime entities, temporary-root cleanup, tracked execution, and async disposal. Do not add product scenarios or command-specific helpers to these primitives.

Product-specific setup belongs in a thin owner-local fixture that translates semantic state into generic boundary state. For example, Git, npm, editor, agent, network-observation, and diagnostics fixtures arrange their external world while the real owner implementation runs.

Never mutate `process.env`, call `process.chdir()`, replace console or process-stream properties, install global fake timers, toggle global logger state, or use a mutable dependency registry. Parallel harnesses must remain independent.

## Stateful External Systems

Prefer durable state and final outcomes over call counts or arbitrary method handlers:

- Runtime tests create managed containers, images, volumes, builds, and exec sessions, then inspect resulting state and ordered events.
- Process tests configure exact command outcomes or managed children, then observe results, signals, liveness, and cleanup.
- TCP tests open, close, or fail endpoints and inspect connection attempts.
- Owner-local fixtures expose semantic setup while keeping generic process, runtime, and TCP contracts free of product-specific APIs.

Use events only for request options, read operations, and ordering that have no durable state. Do not add queued responses, per-method override callbacks, or permissive success defaults.

## Real Filesystem Isolation

Filesystem behavior stays real. Every harness or component test that writes files owns a unique temporary root created with `createTestDir()` and removed with `cleanupTestDir()` or async disposal. Root host paths through `HostEnvironment` and container paths through `SandboxEnvironment.filesystemRoot`. Do not use an in-memory filesystem, shared fixture directory, `process.chdir()`, or the developer's home/config/data directories.

## Deterministic Technical Behavior

Use the scoped test clock for current time and abortable sleeps. Advance time explicitly and settle scheduled work instead of waiting in real time or replacing global timers. Use the stateful process adapter with the real `ProcessManager` for exact exit codes, stdout/stderr, source results, authoritative exits, signals, title restoration, child identity, lifetime, interaction, stopping, detachment, disposal, and cancellation. Its external-process controls model disappearance, stable-identity replacement, signal errors, graceful exit, forced exit, and survivors so started and captured resources run through the same production lifecycle contracts. Use the stateful TCP service for listening, closed, failed, delayed-readiness, and cancellation behavior. Disposal must clear pending timers, waiters, signals, children, streams, and executions.

## Terminal and Output Interaction

The real application has one input stream and screen, so terminal interaction stays on `app.tui`, not prompt-scoped handles. Drive explicit bytes through `type()`, `enter()`, `space()`, arrows, `escape()`, and `chord()`. Synchronize with bounded `waitForText()` calls and inspect the rendered screen or captured output.

Host presentation uses the execution-scoped logger and terminal. Container-tools protocol, help, version, and lifecycle output uses its scoped terminal directly. Assert stdout and stderr separately, including silence, debug output, cancellation, and exact child exit propagation.

User cancellation and harness disposal are distinct. User cancellation sends real terminal bytes or a modeled signal and asserts the application result. Disposal aborts harness-owned work, settles active scope callbacks, and releases resources.

## Collaborator Boundaries

| Collaborator | Application tests |
| --- | --- |
| Commander or container-tools dispatch | Real |
| Configuration loading, trust, TOML updates | Real |
| Product parsing and orchestration | Real |
| Prompt implementation and keyboard handling | Real |
| Temporary filesystem | Real, unique roots |
| Host or sandbox environment | Replaceable technical boundary |
| Terminal, clock, process, TCP | Replaceable technical boundaries |
| Container runtime | Stateful contract world |
| Product-specific external setup | Thin owner-local fixture |
| Product command or use-case function | Never replace |

## Behavior-First Coverage

Coverage thresholds are regression floors, not test-design goals. Start from a user-visible behavior, contract, error, race, or edge case, then test it at the narrowest realistic level. Prefer final state and output over implementation calls. Do not add source-text assertions, impossible-state tests, test-only branches, duplicated assertions, or tests that merely execute an uncovered line. If uncovered code appears dead, inspect callers and history for a missing or unfinished feature before removing it.

## Coverage Gate

Run `bun run coverage:check` for the repository gate. Bun runs the source tests with coverage and writes text and LCOV reports. The small `scripts/check-coverage.ts` script sums LCOV line totals and enforces 95% aggregate line coverage.

`bun check` runs non-test validation tasks in parallel. It then runs `coverage:check` alone so Bun coverage does not overlap build tasks. The pre-commit path runs lint-staged first and then the same gate. GitHub Actions uses `bun run check --verbose` as its validation entry. It retains `coverage/lcov.info` as an artifact.

Architecture tests are the regression boundary for process ownership. They reject child-process imports and handles, child or PID signalling, liveness probing, unref, and Node process signal subscriptions outside `platform/process`. Review-time text searches may diagnose violations, but they are not the enforcement mechanism.

## Targeted End-to-End Boundaries

Use real-container tests only for boundaries that the deterministic harnesses cannot prove. These boundaries include terminal descriptors, signals, PID 1 behavior, container readiness, settings permissions, network setup, image builds, and runtime cleanup. Do not repeat command matrices or deterministic business rules in Docker tests. See `tests/e2e/` for E2E prerequisites and fixture rules.
