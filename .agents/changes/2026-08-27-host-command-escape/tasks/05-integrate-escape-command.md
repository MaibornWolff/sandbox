---
id: 05
dependencies:
- 04
---

# Task 05: Integrate escape into Sandbox sessions

Expose `sandbox escape` inside normal Sandbox execution sessions and scope the host broker to the matching `docker exec` or `podman exec` lifetime. Complete user documentation and Docker-backed feature coverage.

## Design

* `design.md#user-interface`
* `design.md#list-allowed-commands`
* `design.md#existing-integration-points`
* `design.md#test-strategy`
* `design.md#register-escape-in-the-public-cli`
* `design.md#list-effective-patterns-as-plain-text`

## Work

* [x] Create and provide `WebSocketService` once in `src/apps/sandbox/production-application.ts` and provide a matching technical fixture in the Sandbox application test harness
* [x] Register the public command in `src/apps/sandbox/commands/escape-command.ts` and `create-program.ts` with `sandbox escape -- <command>` and `sandbox escape --list`
* [x] Preserve all arguments after `--`, reject an absent command unless `--list` is present, and return module exit behavior through the existing application error boundary
* [x] Report a specific nonzero error when `sandbox escape` runs on the host or without active broker environment data
* [x] Update in-container command help and `displaySandboxInfo()` without adding escape behavior to `sandbox-container-tools`
* [x] Make `sandbox-containers` depend directly on `host-command-escape` in `architecture.ts`
* [x] Start `HostCommandEscapeSession` after container readiness and before normal runtime exec in `src/modules/sandbox-containers/lifecycle/container-execution.ts`
* [x] Pass the session endpoint, subprotocol, and token through `src/modules/sandbox-containers/arguments/session-arguments.ts` only to that execution session
* [x] Redact session authentication data from runtime command displays and verbose logs
* [x] Dispose the broker after runtime exec success, failure, cancellation, or signal handling and do not start it for `sandbox container start`
* [x] Extend Sandbox application and container-execution tests for command parsing, list output, environment injection, broker lifetime, foreground exclusion, exit codes, and cleanup
* [x] Add a dedicated `tests/e2e/host-command-escape.test.ts` project that proves allowed and denied execution, list output, stdin, separated stdout and stderr, exit codes, filtered-network reachability, and session cleanup through a real container
* [x] Update `README.md`, `docs/ARCHITECTURE.md`, `docs/DATA-FLOW.md`, `docs/CONFIG-CASCADE.md`, and other affected user guidance with configuration, usage, limitations, and the host security boundary

## Verification

* [x] An agent inside a normal session can list effective host command patterns without a heading
  **Note:** Verified via `src/apps/sandbox/escape-command.test.ts` and session environment integration tests.
* [x] `sandbox escape -- <command>` runs an allowed host command and preserves stdin, stdout, stderr, and exit status
  **Note:** Verified via host-command session tests and public CLI exit-code tests.
* [x] Host invocation and container invocation without active session data fail with a specific nonzero error
  **Note:** Verified via `src/apps/sandbox/escape-command.test.ts`.
* [x] Denied commands cannot create host-side effects
  **Note:** Verified via broker tests that assert denial before process creation.
* [x] Reused containers receive escape access only for the active outer CLI execution session
  **Note:** Verified via Sandbox execution tests that assert a new token for each reused-container execution.
* [x] `sandbox container start` does not start or inject an escape broker
  **Note:** Verified via Sandbox foreground execution tests.
* [x] The normal filtered network mode reaches the authenticated broker without a broader network-policy exception
  **Note:** Verified via `bun test --timeout 30000 tests/e2e/host-command-escape.test.ts` through host escape. All six tests passed.
* [x] Closing the outer Sandbox session makes its endpoint and token unusable and stops active escaped children
  **Note:** Verified via the stale-session and normal outer-session cleanup cases in `tests/e2e/host-command-escape.test.ts`.
* [x] Public documentation explains the allowlist, security responsibility, pipe limitation, host environment, and lack of inline environment assignment support
  **Note:** Verified via review of `README.md` and the affected architecture documents.
* [x] `bun check` passes
  **Note:** Verified via `bun check`.
* [x] The complete E2E suite passes on the host
  **Note:** Verified via `sandbox escape -- bun run test:e2e`: 73 tests passed across 15 files.
