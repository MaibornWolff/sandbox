---
id: 04
dependencies:
- 01
- 02
- 03
---

# Task 04: Build authenticated host-command escape sessions

Implement the host broker and container client as one product capability. Prove authorization, working-directory control, process streaming, protocol behavior, and session cleanup before connecting the capability to container execution.

## Design

* `design.md#runtime-architecture`
* `design.md#session-connection`
* `design.md#protocol-operations`
* `design.md#working-directory`
* `design.md#environment`
* `design.md#exit-behavior`
* `design.md#security-model`
* `design.md#product-component`
* `design.md#stop-child-processes-with-the-session`

## Work

* [x] Add strict control-message and binary-channel contracts in `src/modules/host-command-escape/protocol.ts`
* [x] Add `startHostCommandEscapeSession()` and `HostCommandEscapeSession` under the module facade without adding a permanent product service or dependency token
* [x] Start a random-port WebSocket broker with a new high-entropy token and expose only the client endpoint data through `clientEnvironment`
* [x] Authenticate during the WebSocket upgrade, require the versioned subprotocol, and reject malformed or unauthorized connections before operation handling
* [x] Implement one-operation-per-connection behavior for `list` and `execute`, with concurrent independent connections
* [x] Keep allowed patterns only in the host session and authorize every command request before process creation
* [x] Map the client working directory from the container project root to the host project root with platform-safe traversal, existence, canonical-path, and symlink checks
* [x] Start authorized commands through `ProcessManager` with `stdio: "stream"`, direct argv, the mapped working directory, and the host process environment
* [x] Forward stdin, stdout, and stderr through their binary channels with end-to-end backpressure and explicit `stdin-end`
* [x] Forward supported signals and preserve normal child exit codes, denied exit code `126`, missing executable exit code `127`, and protocol failure behavior
* [x] Stop the child on client disconnect and stop all connections and children when `HostCommandEscapeSession` is disposed
* [x] Implement `runHostCommandEscape()` for execute and list operations by using the current environment and terminal resources
* [x] Add verbose lifecycle and authorization logs with token and command-argument redaction
* [x] Add module tests with real temporary filesystems, deterministic process fixtures, and real local WebSocket transport where the technical boundary must be proven

## Verification

* [x] `list` returns the effective host-side configuration snapshot without reading container configuration
  **Note:** Verified via the authenticated real-WebSocket list session test.
* [x] A denied command writes the specified stderr message, returns `126`, and starts no host process
  **Note:** Verified via the denied-command broker test and process request assertion.
* [x] An allowed command receives the original argv, mapped project directory, and unchanged host environment without a shell
  **Note:** Verified via the streaming process request and client integration tests.
* [x] Container-only environment values and `NAME=value` prefixes receive no special forwarding behavior
  **Note:** Verified via the client integration test with a container-only value and literal `NAME=value` argument.
* [x] stdin, stdout, and stderr stream concurrently with bounded buffering and preserved channel separation
  **Note:** Verified via the module stream test and the awaitable large-send WebSocket platform test.
* [x] Child exit codes, missing executables, supported signals, disconnects, and broker disposal produce the designed observable results
  **Note:** Verified via exit, missing executable, direct signal, container CLI termination forwarding, concurrent disconnect, and session disposal tests.
* [x] Traversal, missing directories, and symlink escapes cannot select a working directory outside the host project root
  **Note:** Verified via real temporary filesystem traversal, missing path, and escaping symlink tests.
* [x] Invalid tokens, protocol versions, messages, channels, and payload sizes cannot start a host process
  **Note:** Verified via real-WebSocket upgrade, malformed control, invalid binary channel, and oversized payload tests.
* [x] Concurrent allowed requests do not share process or stream state
  **Note:** Verified via two concurrent authenticated execute connections with independent process requests and cleanup.
* [x] `bun check` passes
  **Note:** Verified via `bun check` after implementation.
