---
id: 05
dependencies:
- 04
---

# Task 05: Complete migration and end-to-end coverage

Publish the structured matcher syntax in all user-facing configuration surfaces. Prove the security boundary through a real Sandbox container and host broker session.

## Design

* `design.md#configuration`
* `design.md#rule-tests`
* `design.md#list-output`
* `design.md#migration`
* `design.md#broker-and-command-tests`
* `design.md#references`

## Work

* [x] Replace wildcard host-command examples in `templates/config.toml` and `templates/project-config.toml` with `[[allow_host_commands]]` rules.
* [x] Update `README.md`, `docs/CONFIG-CASCADE.md`, and relevant architecture or data-flow documentation for exact arguments, alternatives, regex matchers, repetition, rule tests, accumulation, and canonical list output.
* [x] Document that the executable is always exact, regular expressions match one complete argument, repetition is bounded, and arbitrary allowed URLs can disclose data.
* [x] Add a migration example that replaces old wildcard strings and state that Sandbox rejects the old format.
* [x] Update configuration test fixtures and helpers that write `allow_host_commands` TOML.
* [x] Update `tests/e2e/host-command-escape.test.ts` to use structured rules and preserve its existing session, stream, denial, cleanup, and signal coverage.
* [x] Add real-session coverage for a rule that permits HTML arguments and HTTP or HTTPS URLs while rejecting application paths, `file:` URLs, and application-selection options.
* [x] Assert canonical `sandbox escape --list` output through the real container boundary.
* [x] Run all repository checks and the focused Docker-backed end-to-end test when the environment provides a container runtime.

## Verification

* [x] Generated templates contain valid TOML 1.0 matcher rules and no old wildcard command strings.
  **Note:** Verified with an ad hoc `smol-toml` parse and wildcard-string check for both templates.
* [x] Documentation gives copyable examples for exact, alternative, regex, repeat, `test_match`, and `test_no_match` syntax.
  **Note:** Verified with an ad hoc `smol-toml` parse of all TOML examples in the README host-command section.
* [x] A real container session allows the documented HTML and web URL examples.
  **Note:** Verified by the structured repetition-rule case in `tests/e2e/host-command-escape.test.ts`.
* [x] The same session rejects application paths, `file:` URLs, application-selection options, unmatched commands, and unexpected trailing arguments before host process creation.
  **Note:** Verified by the recorded host-invocation and denied-effect cases in `tests/e2e/host-command-escape.test.ts`.
* [x] Real-session list output matches the documented canonical format.
  **Note:** Verified by the canonical list case in `tests/e2e/host-command-escape.test.ts`.
* [x] Existing stream, exit-code, signal, stale-session, and child-cleanup E2E behavior remains valid.
  **Note:** Verified by the focused eight-case host-command E2E suite.
* [x] `bun check` passes.
  **Note:** Verified with the full optimized repository check after all edits.
* [x] `sandbox escape -- bun test --timeout 30000 tests/e2e/host-command-escape.test.ts` passes when Docker or Podman is available on the host.
  **Note:** Verified through host escape in Sandbox. All eight tests passed.
