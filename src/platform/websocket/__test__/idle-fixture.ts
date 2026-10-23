import assert from "node:assert/strict";
import { createNodeWebSocketService } from "../node-websocket-service.js";

// Longer than the broker's former 5 second idle limit.
const idleMilliseconds = 5500;
const protocol = "idle-fixture.v1";
const service = createNodeWebSocketService();
await using server = await service.startServer({
  host: "127.0.0.1",
  port: 0,
  protocol,
  maxMessageBytes: 1024,
  authorizeUpgrade: () => ({ accepted: true as const }),
});
await using client = await service.connect({
  url: `wss://127.0.0.1:${server.endpoint.port}/quiet`,
  protocol,
  maxMessageBytes: 1024,
  pinnedCertificate: server.certificate,
});
const accepted = await server.connections[Symbol.asyncIterator]().next();
assert.ok(!accepted.done);
await using remote = accepted.value;
await new Promise((resolve) => setTimeout(resolve, idleMilliseconds));
await client.sendText("after idle");
const message = await remote.messages[Symbol.asyncIterator]().next();
assert.deepEqual(message.value, { type: "text", data: "after idle" });
