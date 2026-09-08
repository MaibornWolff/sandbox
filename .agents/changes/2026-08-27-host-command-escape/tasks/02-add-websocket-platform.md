---
id: 02
dependencies: []
---

# Task 02: Add the WebSocket platform boundary

Add one generic WebSocket platform component for authenticated local servers and clients. Hide the `ws` package and Node.js socket behavior behind disposable, backpressure-aware resources.

## Design

* `design.md#session-connection`
* `design.md#protocol-operations`
* `design.md#websocket-platform-component`
* `design.md#use-authenticated-websocket`

## Work

* [x] Add `ws` as a runtime dependency in `package.json` and add its TypeScript declarations when the package requires them
* [x] Declare the new `platform/websocket` component and its direct dependencies in `architecture.ts`
* [x] Define `WebSocketService`, `WebSocketServer`, and `WebSocketConnection` contracts under `src/platform/websocket/`
* [x] Model servers and connections as `AsyncDisposable` resources with asynchronous incoming messages and awaitable text and binary sends
* [x] Expose generic upgrade metadata and an accept-or-reject callback so product code can authenticate before a WebSocket session starts
* [x] Support a required subprotocol, disabled compression, strict message-size limits, connection close details, and abort signals
* [x] Implement the production adapter with `ws` in `src/platform/websocket/node-websocket-service.ts`
* [x] Add dependency-injection provider and getter functions through `src/platform/websocket/index.ts`
* [x] Add co-located tests against real loopback WebSocket connections for text, binary data, backpressure, authentication rejection, subprotocol rejection, payload limits, close behavior, cancellation, and disposal

## Verification

* [x] A client and server can exchange ordered text and binary messages through the platform contracts
  **Note:** Verified via the real-loopback ordered text and binary exchange test.
* [x] Awaitable sends propagate socket backpressure to the caller
  **Note:** Verified via the real-loopback large-send completion test.
* [x] An upgrade can be rejected before the server exposes a connection
  **Note:** Verified via the real-loopback authorization rejection test.
* [x] Compression is disabled and oversized messages close the connection with a specific failure
  **Note:** Verified via upgrade metadata and close-code 1009 loopback tests.
* [x] Disposing a server closes its listener and active connections
  **Note:** Verified via the abort-driven server disposal loopback test, including active connection closure and failed reconnection.
* [x] The platform component contains no host-command protocol or authorization policy
  **Note:** Verified by architecture checks and inspection of the generic platform contracts and adapter.
* [x] The existing `container-system` TCP connection probe remains unchanged
  **Note:** Verified via an empty Git diff for `src/platform/container-system/tcp-service.ts`.
* [x] `bun check` passes
  **Note:** Verified via `bun check` after implementation.
