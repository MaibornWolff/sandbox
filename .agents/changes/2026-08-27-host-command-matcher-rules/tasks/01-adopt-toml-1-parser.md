---
id: 01
dependencies: []
---

# Task 01: Adopt TOML 1.0 parsing

Replace the current TOML parser with a Node.js-compatible TOML 1.0 parser. Preserve existing configuration behavior while enabling the mixed-type arrays required by host-command matcher patterns.

## Design

* `design.md#configuration`
* `design.md#implementation-boundaries`
* `design.md#require-toml-10-mixed-arrays`

## Work

* [x] Replace `@iarna/toml` in `package.json` and the lockfile with a maintained TOML 1.0 parser that works on macOS, Linux, and Windows.
* [x] Update `src/modules/configuration/toml-config-loading.ts` to use the new parser without changing configuration ownership or error boundaries.
* [x] Add parser-boundary coverage for mixed arrays that contain strings, nested arrays, and inline tables.
* [x] Add regression coverage for existing strings, numbers, booleans, arrays, inline tables, array tables, comments, and multiline values used by Sandbox configuration.
* [x] Preserve strict rejection of duplicate keys, malformed TOML, and unsupported values with errors that identify the configuration path.
* [x] Remove the old parser dependency and all old parser imports.

## Verification

* [x] A TOML array can contain a literal string, a nested array, and an inline table.
  **Note:** Verified by `config-loading.test.ts` in the mixed-array parser-boundary test.
* [x] Existing global and project configuration fixtures parse to the same data as before.
  **Note:** Verified by `config-loading.test.ts` value-form tests and the global and project configuration tests in `bun check`.
* [x] Duplicate keys and malformed TOML fail with the configuration path in the error.
  **Note:** Verified by `config-loading.test.ts` parser-error tests.
* [x] The parser and its dependency work through Node.js-compatible application code on macOS, Linux, and Windows.
  **Note:** Verified by the Node.js ESM application smoke test, the CommonJS package smoke test, and the platform-neutral build in `bun check`.
* [x] `bun check` passes.
  **Note:** Verified by `bun check` after temporarily moving the ignored local `.sandbox` directory out of the repository.
