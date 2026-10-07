import assert from "node:assert/strict";
import { createNodeWebSocketService } from "../node-websocket-service.js";

const service = createNodeWebSocketService();
const protocol = "tls-fixture.v1";
const options = {
  host: "127.0.0.1",
  port: 0,
  protocol,
  maxMessageBytes: 1024,
  authorizeUpgrade: () => ({ accepted: true as const }),
};
await using server = await service.startServer(options);
await using otherServer = await service.startServer(options);
assert.ok(server.certificate);
assert.ok(otherServer.certificate);
const clientOptions = {
  url: `wss://127.0.0.1:${server.endpoint.port}/private`,
  protocol,
  maxMessageBytes: 1024,
};
await assert.rejects(
  service.connect({
    ...clientOptions,
    pinnedCertificate: otherServer.certificate,
  }),
);
await using client = await service.connect({
  ...clientOptions,
  pinnedCertificate: server.certificate,
});
const accepted = await server.connections[Symbol.asyncIterator]().next();
assert.ok(!accepted.done);
await using remote = accepted.value;
assert.equal(remote.path, "/private");
await client.sendBinary(Uint8Array.of(0, 128, 255));
const message = await remote.messages[Symbol.asyncIterator]().next();
assert.deepEqual(message.value, {
  type: "binary",
  data: Uint8Array.of(0, 128, 255),
});
await assert.rejects(client.sendBinary(new Uint8Array(1025)), /maximum size/u);
await remote.sendText("encrypted");
assert.deepEqual((await client.messages[Symbol.asyncIterator]().next()).value, {
  type: "text",
  data: "encrypted",
});
await client.close();
assert.equal((await remote.closed).code, 1000);
