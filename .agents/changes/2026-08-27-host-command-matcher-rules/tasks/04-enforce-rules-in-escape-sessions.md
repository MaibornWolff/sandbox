---
id: 04
dependencies:
- 03
---

# Task 04: Enforce rules in escape sessions

Use compiled structured rules as the host broker authorization boundary. Preserve direct process execution and expose the effective policy through canonical `sandbox escape --list` output.

## Design

* `design.md#matching-semantics`
* `design.md#regular-expression-safety`
* `design.md#list-output`
* `design.md#implementation-boundaries`
* `design.md#broker-and-command-tests`

## Work

* [x] Change `StartHostCommandEscapeSessionOptions` and its callers to pass structured runtime rules instead of command strings.
* [x] Compile the effective rules in `src/modules/host-command-escape/` before the broker accepts requests and retain only immutable compiled policy state for the session.
* [x] Update `src/modules/host-command-escape/broker.ts` to authorize the original request argument vector against complete structured patterns before process creation.
* [x] Keep executable lookup, working-directory validation, direct argument passing, host environment use, stream behavior, signals, and exit codes unchanged.
* [x] Keep the existing control protocol operation for list output and send canonical compact JSON pattern strings without rule tests.
* [x] Update `src/modules/host-command-escape/protocol.ts`, `client.ts`, and related types only where the canonical list contract requires it.
* [x] Update session, broker, protocol, client, application-command, and container-execution tests to use structured rules.
* [x] Add runtime coverage for nested alternatives, regular-expression alternatives, bounded repetition, denied trailing arguments, and denial before process creation.
* [x] Preserve redacted verbose logs and add specific warnings or errors for unexpected policy compilation failures.

## Verification

* [x] The broker allows a request only when one structured rule consumes its complete argument vector.
  **Note:** Verified by `session.test.ts` with recursive alternatives, regular expressions, bounded repetition, and denied trailing arguments.
* [x] A denied request cannot create a host-side effect.
  **Note:** Verified by `session.test.ts`, which asserts that denied requests do not add process start requests.
* [x] `sandbox escape --list` prints one canonical JSON pattern per line, in effective order, without tests or a heading.
  **Note:** Verified by the session list test and `escape-command.test.ts`.
* [x] An empty effective policy prints no list output and denies all execution requests.
  **Note:** Verified by the empty-policy session test and the empty-list application command test.
* [x] The client and broker preserve stdin, separate stdout and stderr, signals, and child exit codes.
  **Note:** Verified by the existing session and client stream, signal, and exit-code tests with structured rules.
* [x] The broker still starts processes directly without a shell.
  **Note:** Verified by `session.test.ts`, which asserts the direct process command and argument array.
* [x] `bun check` passes.
  **Note:** Verified with `bun check`. The repository-local `.sandbox/` marker was temporarily hidden and restored because it changes test project-root discovery.
