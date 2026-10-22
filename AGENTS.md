# Sandbox Development Guide

## Working with the user

- Use ASD-STE100 Simplified Technical English. Write short, direct responses without filler, em dashes, or semicolons.
- For consequential host changes, request confirmation under labeled sections: purpose, changes, risks, recovery, and confirmation.
- Get explicit confirmation in the current chat before each push. Approval applies only to that push.
- Publish releases only when the user explicitly requests them.

## Workflow

- Follow repository migration notices and confirm the active repository before making product changes.
- Reproduce bugs with a failing test before fixing them. Verify CLI fixes with the reported command when the required runtime is available.
- For startup optimizations, record timings with the reported CLI command before and after each change.
- Run `bun check` after changes to code, scripts, or configuration. Use individual checks only for targeted debugging.
- For documentation-only changes, check links and run `git diff --check`. Run `bun check` only if the user requests it.
- Keep deprecation diagnostics fatal and fix their causes rather than suppressing them.
- For user-visible changes, update `CHANGELOG.md` under `Unreleased` and include migration steps for breaking changes. Write for product users, not contributors. Keep released sections unchanged except for factual corrections.
- Create repository worktrees under `.agents/worktrees/`.

## Code

- Keep production code compatible with Node.js and Windows. Use Bun-specific APIs only in tests.
- Load synchronous and asynchronous disposal polyfills before application code in each Node.js entrypoint.
- Use concrete types and supported APIs rather than `any`, `@ts-ignore`, or `biome-ignore`.
- Reuse existing helpers before adding abstractions. When changing an internal signature, update its callers rather than adding compatibility shims unless requested.
- Use disposables for cleanup. Await asynchronous work before leaving its disposal scope.
- Preserve child-process exit codes and report specific errors. Add verbose logs for main actions and warnings or errors for unexpected behavior.
- Use `chalk.cyan()` for commands and resource names, `chalk.dim()` for paths, and `chalk.bold()` for emphasis in logs.
- Preserve user-configured package registries unless the user requests an override.
- Resolve project-relative paths with `getRepoRootPath(process.cwd())`. Use `getSandboxConfigDir()` and `getDataHomeDir()` for platform- and XDG-aware configuration and data paths.

## Architecture

- Keep dependencies inward: apps can use modules, platform, and shared code. Modules can use modules, platform, and shared code. Platform can use platform and shared code. Shared code depends only on shared code. Avoid cycles.
- Keep declared architecture dependencies identical to direct production dependencies.
- Give each capability, runtime resource, and technical boundary one component owner. Construct resource paths in that owner and expose complete operations rather than internal steps.
- Expose component APIs through `index.ts`. Use `#apps/*`, `#modules/*`, `#platform/*`, `#shared/*`, or `#test/*` aliases across components and relative imports with explicit file extensions within a component.
- Export only APIs used outside their defining module. Keep exports in their owning component rather than re-exporting another component's APIs.
- Construct technical integrations once at composition roots. Keep configuration code concerned with data, not operational services.
- Access Docker and Podman only through `ContainerRuntime`. Keep runtime CLI logic in `src/platform/container-runtime/`.
- Keep runtime-only changes from rebuilding system, user, or project tool images.

## Task-specific guidance

- When changing component boundaries or lifecycle, read [architecture](contributing/ARCHITECTURE.md) and update it if core concepts change.
- When implementing behavior, fixing bugs, or adding or changing tests, use the [test-writing skill](.agents/skills/test-writing/SKILL.md) to decide what to test and at which level.
- Before publishing or recovering a release, follow [release instructions](contributing/RELEASING.md).

## Maintaining guidance

- Treat every rule as an attention cost. Keep only intentional, repository-specific guidance that changes future decisions.
- Treat feedback as evidence to consider, not an automatic instruction to add a rule. Add guidance only when it changes future decisions across tasks, and first check whether an existing rule can be sharpened.
- Put conditional guidance in the narrowest relevant scope and state when to read it. Leave commands, layouts, and configuration details in their authoritative files when they are easy to find.
- Write product usage, configuration, and operation guides in `docs/`, contributor guides in `contributing/`, and agent workflows and decision rules in repository-local skills. Keep only essential rules and activation pointers in `AGENTS.md`.
- Write direct instructions without uppercase requirement labels. Remove repetition, conflicts, and rules the agent follows without being told.
