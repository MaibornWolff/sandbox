---
id: 01
dependencies: []
---

# Task 01: Add backpressure-aware process streaming

Add a typed process mode that gives callers direct, backpressure-aware access to child stdin, stdout, and stderr. Preserve all existing capture, inherit, ignore, interactive, and detached behavior.

## Design

* `design.md#process-platform-changes`
* `design.md#streams-and-terminal-behavior`
* `design.md#add-a-typed-streaming-process-mode`

## Work

* [x] Add `StreamingProcessRequest`, `StreamingProcessResult`, `ProcessInput`, and `ManagedStreamingProcess` contracts in `src/platform/process/process-manager.ts`
* [x] Add a discriminated `stdio: "stream"` overload to `ProcessManager.start()` without adding optional streams to other managed process modes
* [x] Update `src/platform/process/process-adapter.ts`, `process-lifecycle.ts`, and `node-process-adapter.ts` to create and manage streaming process handles through the existing identity, signal, stop, and disposal logic
* [x] Make `ProcessInput.write()` wait for child-pipe backpressure and make `ProcessInput.end()` close child stdin without stopping output collection
* [x] Expose stdout and stderr as separate asynchronous byte iterators without buffering complete output in `ProcessResult`
* [x] Stop the child and settle stream consumers when process startup fails, a stream fails, the request is aborted, or the handle is disposed
* [x] Extend `src/platform/process/__test__/process-test-harness.ts` with generic streaming input and output primitives that model the real process resource
* [x] Add co-located tests for streaming type validation, stdin, end-of-input, separated output, backpressure, signals, failures, and disposal

## Verification

* [x] A streaming child receives stdin chunks in order and observes end-of-input
  **Note:** Verified via `process-streaming.test.ts` ordered input and end-of-input test.
* [x] stdout and stderr can be consumed concurrently as separate byte streams
  **Note:** Verified via `process-streaming.test.ts` separated output test and the streaming harness test.
* [x] A slow child causes `ProcessInput.write()` to wait instead of buffering without a limit
  **Note:** Verified via `process-streaming.test.ts` slow child pipe test with an 8 MiB write.
* [x] Process exit codes and signals remain available through the streaming result and managed-process lifecycle
  **Note:** Verified via `process-streaming.test.ts` exit-code assertions and the streaming harness signal lifecycle test.
* [x] Disposal stops a running streaming child and settles all pending input and output operations
  **Note:** Verified via `process-streaming.test.ts` real-child disposal test and the streaming harness disposal test.
* [x] Existing inherited, captured, ignored, interactive, detached, and callback-based process behavior remains unchanged
  **Note:** Verified via the complete existing process test suite and `bun check`.
* [x] `bun check` passes
  **Note:** Verified via `bun check` with lint, typecheck, knip, cpd, build, script tests, architecture, and coverage checks passing.
