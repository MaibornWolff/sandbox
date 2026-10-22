---
name: test-writing
description: Choose whether and how to test a change. Use when adding or changing tests, implementing behavior, or fixing bugs.
---

# Test Writing

Prove behavior with the smallest test that can detect the failure.
For contributor setup and check commands, read `CONTRIBUTING.md`.
Before writing tests, read `<skill-dir>/references/harnesses.md` for repository harnesses and isolation.

## Decide whether a test is needed

Name the behavior and the failure the test would detect before writing it.

- For new or changed product behavior, add or update a test for the affected contract.
- For a refactor, use existing behavior tests unless a meaningful gap appears.
- For repository tooling configuration, such as CI workflows, package scripts, lint settings, or TypeScript settings, validate with the relevant validator or changed command and `bun check`. Do not add tests that parse these files only to check their entries.
- For product configuration behavior, test parsing, validation, defaults, precedence, and trust when affected. Use real configuration files when the filesystem is part of the contract.
- If product code reads or ships a checked-in file, test the behavior it produces, such as resolved configuration or an installed tool, rather than its literal text.
- For documentation-only or type-only changes, use the validation required by `AGENTS.md` rather than adding runtime tests without a behavior to prove.

## Choose the test level

Use the lowest level that can prove the named behavior.
Keep detailed input combinations at that level rather than repeating them through broader workflows.

- Pure test: parsing, validation, normalization, formatting, sorting, path calculation, or argument construction.
- Component test: an owner's contract, state transitions, persistence, or boundary adapter. Use real temporary files for filesystem behavior.
- Application harness: command registration, orchestration across components, prompts, output, exit codes, or application state. Keep product commands, configuration, parsers, and orchestration real.
- Shell test: shell initialization or script behavior that depends on shell execution.
- E2E test: behavior that requires a real container boundary, such as bind mounts, firewall enforcement, terminal descriptors, or signals. Read `tests/e2e/AGENTS.md` before adding or changing E2E tests.

Replace only external technical boundaries.
Do not start a container just to inspect generated arguments.

## Write and verify

1. Inspect nearby tests and reuse the owner-local fixture or application harness. Co-locate tests as `foo.ts` and `foo.test.ts`.
2. Assert observable results, such as resolved configuration, files, output, exit codes, or state. Avoid assertions that merely restate source text, registry entries, generated scripts, or language features.
3. Keep each test focused on one outcome. Cover failure and edge cases when they exercise a distinct contract.
4. For a regression, run the focused test before the fix and confirm it fails for the reported reason. After the fix, confirm it passes.
5. For shell script changes, run `bun run test:shell`. For container behavior changes, run focused E2E tests as described in `tests/e2e/README.md`. Then run `bun check`.

Do not add tests solely to increase coverage or to test E2E assertion helpers and fixture validation in isolation.
When inspecting missing behavioral coverage, use the `test-coverage-fix` skill.
Use coverage reports as diagnostics, not percentage targets or merge gates.

## Completion

Report the behavior covered, the chosen test level, and the verification results.
If no new test is needed, identify the existing coverage or direct validation that proves the change.
