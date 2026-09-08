---
id: 03
dependencies:
- 01
- 02
---

# Task 03: Load and validate structured rules

Make global and trusted project configuration load `[[allow_host_commands]]` rules. Validate matcher structure and rule examples before an effective configuration can start a Sandbox operation.

## Design

* `design.md#configuration`
* `design.md#rule-tests`
* `design.md#configuration-merge`
* `design.md#migration`
* `design.md#configuration-tests`
* `design.md#implementation-boundaries`

## Work

* [x] Replace the string host-command schema in `src/modules/configuration/config-field-catalog.ts` with a strict recursive schema for `pattern`, `test_match`, and `test_no_match`.
* [x] Update `Config.allowHostCommands` and related configuration types to hold matcher-rule data owned by `host-command-escape`.
* [x] Use the public pure matcher validation API during configuration loading without constructing an operational broker or runtime service.
* [x] Run every `test_match` and `test_no_match` argument vector against its containing rule when its configuration file loads.
* [x] Report failed examples with the configuration path, one-based rule number, test field, test index, and complete argument vector.
* [x] Reject the old string-array format with a specific migration error that shows the `[[allow_host_commands]]` form.
* [x] Accumulate user and trusted project rules in configuration order.
* [x] Validate tests before removing structurally equal runtime patterns, then keep the first equal pattern without retaining test data in the effective runtime rule.
* [x] Update configuration debug summaries, active configuration display, generated reference metadata, and their tests for structured rule counts.
* [x] Update `architecture.ts` if configuration now directly uses the public pure host-command matcher API.
* [x] Extend real-filesystem configuration tests for mixed matcher arrays, recursive alternatives, regex errors, unsupported flags, repetition errors, old syntax, rule tests, accumulation, and duplicate removal.

## Verification

* [x] Exact, alternative, regex, and repeat rules load from both global and project TOML files.
  **Note:** Verified by the real-filesystem structured-rule loading test and the global/project configuration service test.
* [x] A failing `test_match` or `test_no_match` rejects configuration before a Sandbox operation starts and identifies the source example.
  **Note:** Verified by `config-loading.test.ts`, which asserts both failure fields, the file path, one-based indexes, and complete argument vectors.
* [x] Rule tests are not present in `Config.allowHostCommands` after validation.
  **Note:** Verified by the configuration merge and service tests, which assert that effective configuration contains patterns only.
* [x] Global and trusted project patterns accumulate in source order and structural duplicates keep the first pattern.
  **Note:** Verified by `configuration-service.test.ts` and `config-merging.test.ts`.
* [x] Old wildcard strings fail with actionable migration guidance and are never translated silently.
  **Note:** Verified by the real-filesystem legacy syntax test in `config-loading.test.ts`.
* [x] Existing non-host-command configuration behavior remains unchanged.
  **Note:** Verified by the existing configuration tests and the full `bun check` suite.
* [x] Declared architecture dependencies match direct production imports.
  **Note:** Verified by the architecture phase of `bun check`.
* [x] `bun check` passes.
  **Note:** Verified with `bun check`. The repository-local `.sandbox/` marker was temporarily hidden and restored because it makes test fixtures resolve the real repository root.
