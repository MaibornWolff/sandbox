---
id: 02
dependencies: []
---

# Task 02: Build the recursive matcher engine

Replace wildcard command strings with a pure argument-vector matcher. Support exact values, recursive alternatives, safe regular expressions, and bounded repetition without changing broker integration yet.

## Design

* `design.md#matcher-forms`
* `design.md#matching-semantics`
* `design.md#regular-expression-safety`
* `design.md#list-output`
* `design.md#matcher-tests`

## Work

* [x] Replace the string matcher model in `src/modules/host-command-escape/command-pattern.ts` with public matcher-rule data types and pure compile, validate, evaluate, and canonical-format APIs.
* [x] Require the first pattern segment to be a non-empty literal executable and require each successful rule to consume the complete argument vector.
* [x] Implement exact argument matchers and recursive alternative arrays for one argument.
* [x] Add a portable linear-time regular-expression dependency and implement automatic full-argument matching with only the documented stateless flags.
* [x] Implement `{ repeat = Matcher, min, max }` with explicit bounds and reject nested repetition.
* [x] Use bounded dynamic programming for repetition and cache matcher states instead of using unbounded recursive backtracking.
* [x] Define and enforce limits for expression length, nesting depth, alternatives, pattern segments, repetition, argument count, and argument length.
* [x] Add canonical compact JSON formatting and structural pattern equality for list output and duplicate removal.
* [x] Return specific validation errors for malformed matchers, unsupported expression syntax, unsupported flags, and exceeded limits.
* [x] Replace `src/modules/host-command-escape/command-pattern.test.ts` with focused coverage for all matcher forms, limits, complete consumption, and bounded evaluation.
* [x] Update `src/modules/host-command-escape/index.ts` to expose only the matcher APIs needed by configuration and runtime integration.

## Verification

* [x] `["git", ["status", "diff", "log"]]` matches only the three exact two-argument commands.
  **Note:** Verified by `command pattern matching > matches literal alternatives as exactly one argument`.
* [x] Nested literal and regular-expression alternatives match one complete argument.
  **Note:** Verified by `command pattern matching > matches nested literal and regular-expression alternatives`.
* [x] Repetition respects `min` and `max`, including `min = 0`.
  **Note:** Verified by the bounded repetition and zero repetition matcher tests.
* [x] A pattern cannot match a different executable or ignore trailing arguments.
  **Note:** Verified by the exact complete argument vector test.
* [x] Regular expressions cannot cross argument boundaries and cannot trigger backtracking denial of service.
  **Note:** Verified by the full-argument anchoring test, the ambiguous alternative bound test, and the RE2 engine dependency.
* [x] Unsupported flags, nested repetition, malformed rules, and all configured limit violations fail before runtime matching.
  **Note:** Verified by the command pattern validation test group.
* [x] Canonical formatting is stable for structurally equal patterns.
  **Note:** Verified by `command pattern canonical form > formats compact JSON with stable matcher property order`.
* [x] `bun check` passes.
  **Note:** Verified by `bun check` with the ignored local `.sandbox` project marker temporarily removed and restored.
