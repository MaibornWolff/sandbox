---
name: test-coverage-fix
description: Find missing behavioral tests. Use when the user asks to inspect or improve test coverage, not to meet a percentage target.
---

# Test Coverage Fix

Improve coverage by finding missing behavior and testing it at the narrowest realistic level.

## Workflow

1. Run `bun run test:coverage` and inspect `coverage/lcov.info` for untested behavior.
2. Inspect each relevant uncovered branch or function and its callers.
3. Name the missing user, contract, failure, or edge behavior before writing a test.
4. Investigate uncovered dead code for a missing caller or unfinished feature before deleting it.
5. Choose the narrowest test level that proves the behavior:
   - Application harness for command registration, orchestration, output, exit codes, and external-world state.
   - Component test for an owned contract, state transition, or boundary adapter.
   - Pure test for parsing, validation, sorting, formatting, path calculation, or argument construction.
6. Add or update the narrowest meaningful behavior test, then implement the required fix.
7. Repeat only for distinct behavior gaps.
8. Run the focused tests and then `bun check`.

## Rules

- Test real product behavior. Replace only external technical boundaries.
- Prefer final state, files, output, exit codes, and durable entities over call counts.
- Use real isolated temporary filesystems for filesystem behavior.
- Use deterministic scoped clocks for time behavior.
- Keep detailed combinations in focused pure or component tests.
- Do not add redundant assertions or tests that only execute lines.
- Do not assert production source text, generated output implied by registries, or metric configuration strings.
- Do not invent impossible states or add test-only production branches.
- Do not replace product commands, parsers, configuration, orchestration, or use cases with mocks.
- Do not retain dead code solely to preserve coverage. Trace history and callers before removal.
- Use coverage reports as diagnostics, not percentage targets or merge gates.

## Completion Report

Report the missing behavior covered, the test level chosen, the files changed, and the verification results.
