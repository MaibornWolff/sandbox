---
id: 03
dependencies: []
---

# Task 03: Add host-command configuration and policy

Let global and trusted project configuration declare allowed host command patterns. Add argument-aware matching that can authorize exact commands or a `*` sequence without using shell parsing.

## Design

* `design.md#configuration`
* `design.md#command-matching`
* `design.md#enforce-permissions-on-the-host`
* `design.md#permit-global-and-project-configuration`

## Work

* [x] Add `allowHostCommands` to `Config` and add `allow_host_commands` to `CONFIG_FIELD_CATALOG` with accumulating merge behavior and an empty default
* [x] Validate each pattern as a nonempty, single-line string and preserve existing strict TOML validation
* [x] Update configuration loading, merging, display, schema, reference, and test fixtures for the new field
* [x] Verify that global and trusted project patterns form a union through the existing content-hash trust flow
* [x] Create the `modules/host-command-escape` component and declare its current direct dependencies in `architecture.ts`
* [x] Implement exact argument-vector matching and standalone `*` matching for zero or more complete arguments in `src/modules/host-command-escape/command-pattern.ts`
* [x] Keep argument boundaries during authorization and do not join requests into an ambiguous command string
* [x] Add effective-pattern normalization that removes duplicates while preserving configuration order for `--list`
* [x] Add co-located matcher tests for exact matches, zero or more wildcard arguments, wildcard position, multiple wildcards, malformed patterns, and argument-boundary attacks
* [x] Add the security comment and representative examples to global and project configuration templates

## Verification

* [x] `allow_host_commands` appears in generated configuration schema and reference output
  **Note:** Verified via `config-reference.test.ts` and the catalog-derived strict schema test.
* [x] Global and trusted project patterns accumulate without a new trust prompt
  **Note:** Verified via the pre-trusted content-hash flow in `configuration-service.test.ts`.
* [x] Empty or multiline patterns fail with a specific configuration error
  **Note:** Verified via `toml-config-schema.test.ts` and real TOML loading in `config-loading.test.ts`.
* [x] An exact pattern permits only the same executable and arguments
  **Note:** Verified via exact-match cases in `command-pattern.test.ts`.
* [x] `open *` permits `open` with zero, one, or many arguments
  **Note:** Verified via wildcard cardinality cases in `command-pattern.test.ts`.
* [x] A request cannot gain permission by changing argument boundaries or relying on shell syntax
  **Note:** Verified via argument-boundary and literal shell-syntax cases in `command-pattern.test.ts`.
* [x] Effective patterns are listed once in their first effective configuration order
  **Note:** Verified via normalization cases in `command-pattern.test.ts`.
* [x] `bun check` passes
  **Note:** Verified via `bun check` after the final implementation changes.
