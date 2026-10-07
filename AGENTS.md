# Sandbox Development Guide

## User Communication

- You MUST use ASD-STE100 Simplified Technical English when talking to the user.
- You MUST organize confirmation prompts for consequential host changes into labeled sections for purpose, changes, risks, recovery, and confirmation.

## Commands

- **Check all:** `bun check` (typecheck + lint + test + build + cpd + knip)

Run individual commands ONLY for targeted debugging, ALWAYS prefer the full, optimized `bun check` command otherwise:

- **Typecheck:** `bun run typecheck`
- **Lint/Format:** `bun run lint`
- **Test:** `bun run test`
- **Build:** `bun run build`
- **Shell script tests:** `bun run test:shell` (needs `sh`, `bash`, and `zsh` on the host, runs in CI on Linux)
- **E2E tests:** `bun run test:e2e`
  - When running inside Sandbox, run focused host E2E tests with `sandbox escape -- bun test <test-file>`.
  - When running inside Sandbox, run all host E2E tests with `sandbox escape -- bun test:e2e`.
- You SHOULD pin CI toolchain dependencies to major versions unless stricter reproducibility is explicitly requested.
- You MUST avoid duplicate branch and merge-request pipelines for the same commit.

## Key Rules

- You MUST run `bun check` after every task
- You MUST NOT use `any`, `@ts-ignore`, or `biome-ignore`.
- You MUST reproduce bugs with a failing test first.
- You MUST verify CLI bug fixes with the reported command when the required runtime is available.
- You MUST verify each startup optimization with the reported CLI command and record its timings before proceeding to the next optimization.
- You MUST NOT weaken E2E tests by replacing failing external fixtures with less equivalent ones without investigating the failure.
- You SHOULD fetch only the relevant tail of long CI logs unless earlier output is needed.
- You MUST keep code Node.js-compatible (no Bun-specific APIs outside tests).
- You MUST load synchronous and asynchronous disposal polyfills in each Node.js entrypoint before application code runs.
- You MUST ensure solutions work on Windows (no reliance on Unix-only system commands like `diff`, `which`, etc.).
- You MUST co-locate tests: `foo.ts` → `foo.test.ts`.
- You MUST use `getRepoRootPath(process.cwd())` for project-relative paths, not `process.cwd()` directly.
- You MUST run Docker-backed tests through `sandbox escape` when permitted and ask for manual testing only when host execution is unavailable.
- You MUST bundle image setup package actions by package manager.
- You MUST keep runtime-only code changes from triggering rebuilds of system, user, and project tool images.
- You MUST keep startup paths performant and avoid redundant container-runtime operations.
- You MUST expose Docker and Podman operations only through the `ContainerRuntime` interface.
- You MUST keep native terminal scrolling available while users review long output.
- You SHOULD size interactive terminal views from the available terminal height.
- You MUST calculate terminal mouse hit regions from rendered physical rows, including wrapped lines.
- You MUST use semantic input actions instead of translating keys into raw terminal escape sequences outside terminal adapters and tests.
- You MUST create repository worktrees under `.agents/worktrees/`.
- You SHOULD use the fewest subagents needed and keep each work package complete and focused.

## Response Style

Use these rules when talking to the user:

- You MUST NOT use em dashes (—) or semicolons. Use colons, regular hyphens (-), or rephrase.
- You MUST NOT use filler affirmations ("Certainly!", "Great!", "Absolutely!").
- You MUST NOT use hollow transition words ("Furthermore", "Moreover", "Additionally", "In conclusion").
- You MUST NOT use AI-favored vocabulary ("leverage", "delve", "it's worth noting", "in the realm of").
- You SHOULD write concisely and directly. Prefer plain words over formal or elaborate phrasing.
- You SHOULD keep CLI option help focused on user actions and omit internal lifecycle details.

## Code Style

- You MUST use specific error messages and preserve exit codes from child processes.
- You SHOULD use an options object for >3 parameters or confusable types.
- You MUST NOT keep backward compatibility for internal function signatures unless explicitly requested.
- You SHOULD use extensible enum values for feature modes and reuse existing configuration merge strategies.
- You SHOULD keep functions under 150 lines and cognitive complexity under 15.
- You MUST include code size, readability, and shared-helper opportunities in code reviews.
- You SHOULD use explicit branches and named phases for lifecycle logic instead of nested ternaries or compressed expressions.
- You SHOULD reuse shared timeout and cancellation helpers instead of repeating timer races and cleanup.
- You SHOULD extract compound validation conditions into named functions when this makes the rule easier to read.
- You SHOULD extract non-trivial mapping and parsing callbacks into named functions.
- If `bun cpd` reports clones, you MUST extract into a shared utility.
- You MUST use `chalk` to highlight key terms in log messages: `chalk.cyan()` for commands and resource names (images, containers, volumes), `chalk.dim()` for file paths, `chalk.bold()` for emphasis. Plain strings for descriptions.
- You SHOULD avoid try/catch/finally. For cleanup prefer disposable. Only catch errors in central places and keep application code simple with minimal branching.
- You MUST await asynchronous operations before leaving an `AsyncDisposable` scope.

## Testing

- You MUST NOT use `mock.module()` because it causes flaky tests due to parallel execution.
- You MUST NOT use `try`/`finally` for test cleanup and MUST use `DisposableStack`, `Disposable`, or `AsyncDisposable` instead.
- You MUST use real temporary filesystems for filesystem behavior and deterministic scoped clocks for time behavior.
- You MUST use explicit platform fixtures in tests and MUST NOT branch or skip based on the host platform.
- You MUST replace only external technical boundaries and keep product commands, parsers, configuration, and orchestration real.
- You MUST keep test-harness primitives generic and expose scenario behavior only through thin owner-local fixtures.
- You MUST model test interaction scopes after real shared resources, including one global TUI input stream and screen per application.
- You MUST improve coverage through missing user, contract, failure, or edge behavior and MUST NOT add redundant tests only to satisfy metrics.
- You SHOULD prefer user-flow tests through existing test harnesses over verbose or duplicated unit tests.
- You MUST test behavior at the lowest level that can validate it and reserve E2E tests for real external boundaries. Examples: test config parsing in a unit test and CLI orchestration in an integration test. Negative example: start Docker only to inspect generated arguments.
- You SHOULD test behavior, not types. You SHOULD NOT test language features (`typeof`, `constructor.name`).
- You SHOULD build test harnesses from generic interaction primitives and keep scenario-specific helpers as thin wrappers.
- You SHOULD avoid scoped test-harness handles when the underlying interaction target is global.
- You MUST assert observable behavior, logic, or parsed structure instead of only checking generated source, scripts, configuration, or text. Examples: assert resolved configuration data and execute an installed tool. Negative example: assert that a generated Dockerfile contains a string.
- You MUST NOT add tests that only restate tool registry values or generated output implied by them.
- You SHOULD use `createTestDir()`/`cleanupTestDir()` from `src/test/utils.ts` for temp directories.
- Coverage: aim for 100% on utils, test config/docker logic, commands MAY use integration-style tests.

## Logging

- You MUST add verbose logs for all main actions. This is CRUCIAL for debugging. The user can activate verbose logs using `--verbose`.
- You MUST log warnings or errors on unexpected behavior. NEVER skip errors silently.
- You SHOULD make user facing logs look modern and colorful. Highlight important elements, like paths or commands in the logs using `chalk`.

## Code Structure

### Components

- `src/apps/` contains executable composition roots for the host CLI and container tools.
- `src/modules/` contains product capabilities and their command APIs.
- `src/platform/` contains side effects and technical integrations.
- `src/shared/` contains pure product-independent helpers.
- `tests/e2e/` contains Docker-backed end-to-end tests. Follow `tests/e2e/AGENTS.md` when you work there.
- `docs/` contains architecture documentation. Update it when you change core concepts.
- Dependencies MUST point inward: apps may use modules, platform, and shared code. Modules may use modules, platform, and shared code. Platform code may use platform and shared code. Shared code may only use shared code.
- You MUST NOT create circular dependencies.
- You MUST keep declared architecture dependencies identical to direct production dependencies.
- You SHOULD keep component directories flat and use subfolders only for exceptional cohesive responsibilities.

### Ownership

- You MUST assign one component owner to each product capability, runtime resource, and technical boundary.
- You MUST construct resource paths in the owning component and reuse its public path APIs elsewhere.
- You MUST keep container runtime CLI logic inside `src/platform/container-runtime/**`.
- You MUST NOT call container runtime binaries outside the container runtime component.
- Configuration code MUST return configuration data without constructing operational runtime services.
- You MUST construct each technical edge once at the composition root.
- You MUST NOT repeat dependency defaults across layers.
- You MUST NOT introduce or expand optional dependency bags during component composition.

### Public APIs

- Each component MUST expose its public API through `index.ts`.
- Cross-component imports MUST use the owning component's `index.ts` facade.
- Cross-component imports under `src` MUST use the `#apps/*`, `#modules/*`, `#platform/*`, `#shared/*`, or `#test/*` aliases.
- Imports within one component MUST use relative paths with explicit file extensions.
- You MUST NOT re-export APIs or types owned by another component.
- You MUST export only functions, types, and interfaces that are used outside the defining module.

### Abstractions

- You MUST prefer small, deep APIs that hide complete workflows.
- You SHOULD prefer one shared workflow across container runtimes and keep necessary runtime differences inside adapters.
- Callers MUST NOT coordinate another component's internal steps.
- You MUST keep intermediate plans and transport formats private unless callers need them to decide behavior.
- Lifecycle operation names MUST state their phase when timing changes behavior.
- You SHOULD keep composition roots linear and delegate complete operations to their owners.
- You SHOULD model separate resource concerns with separate types.
- You SHOULD expose resource completion on its handle instead of a global wait method.

### Files

- You MUST name CLI command files `<name>-command.ts`.
- You MUST NOT use `*-command-registration.ts`.

## Key Files and Concepts

- You SHOULD keep runtime selection in user configuration examples and keep project templates focused on common project settings.

Paths are platform/XDG-dependent. Use `getSandboxConfigDir()` (`{config}`) and `getDataHomeDir()` (`{data}`) — never hardcode `~/.config` or `~/.local/share`.

- `{config}/config.toml` — global user config
- `{config}/docker/Dockerfile` — user-level Dockerfile
- `{config}/settings/` — synced into container home
- `{data}/state.json` - persistent CLI state owned by `platform/state`
- `{data}/global/` — persist volumes shared across projects
- `{data}/{project-slug}/` — persist volumes per project
- `.sandbox/config.toml` — project-level config
- `.sandbox/docker/Dockerfile` — project-level Dockerfile override

## Learning

If the user gives you feedback that can be generalized, you MUST add it as a concise rule to the relevant `AGENTS.md` (root or subfolder). Rules MUST be one-liners using "You MUST/SHOULD/MAY" and avoid verbose code examples. ONLY add rules that should be applied in general, DO NOT add rules that are very specific for only one task.

- You MUST NOT run `bun check` for documentation-only changes unless the user explicitly asks for it.
- You MUST save feedback as guidance only when it applies broadly to future tasks, not when it concerns minor visual preferences or task-specific adjustments.
