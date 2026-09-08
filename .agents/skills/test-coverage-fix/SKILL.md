---
name: test-coverage-fix
description: Repair meaningful test coverage gaps. Use when coverage checks fail, thresholds regress, or the user asks to inspect or improve test coverage. Do not use to add tests solely for a percentage target.
---

# Test Coverage Fix

Improve coverage by finding missing behavior and testing it at the narrowest realistic level.

## Workflow

1. Run `bun run coverage:check` and read its uncovered-file diagnostics.
2. Inspect each relevant uncovered branch or function and its callers.
3. Name the missing user, contract, failure, or edge behavior before writing a test.
4. Investigate uncovered dead code for a missing caller or unfinished feature before deleting it.
5. Choose the narrowest test level that proves the behavior:
   - Application harness for command registration, orchestration, output, exit codes, and external-world state.
   - Component test for an owned contract, state transition, or boundary adapter.
   - Pure test for parsing, validation, sorting, formatting, path calculation, or argument construction.
6. Add or update the narrowest meaningful behavior test, then implement the required fix.
7. Repeat only for distinct behavior gaps.
8. Run `bun run coverage:check` and then `bun check`.

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
- Do not lower checked-in thresholds unless the user approves a documented baseline correction.

## Completion Report

Report the missing behavior covered, the test level chosen, the files changed, the exact verification commands, and the resulting function and line coverage.
