import assert from "node:assert/strict";
import net from "node:net";
import { createNodeWebSocketService } from "../node-websocket-service.js";

// A TCP client that never sends a request must still be closed by the idle timer.
const protocol = "stalled-fixture.v1";
const service = createNodeWebSocketService();
await using server = await service.startServer({
  host: "127.0.0.1",
  port: 0,
  protocol,
  maxMessageBytes: 1024,
  authorizeUpgrade: () => ({ accepted: true as const }),
});
const stalled = net.connect(server.endpoint.port, "127.0.0.1");
const startedAt = Date.now();
await new Promise<void>((resolve) => stalled.once("close", () => resolve()));
assert.ok(Date.now() - startedAt < 10_000);
assert.ok(Date.now() - startedAt >= 4_000);
