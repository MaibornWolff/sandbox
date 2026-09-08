import assert from "node:assert/strict";
import { createNodeWebSocketService } from "../../src/platform/websocket/node-websocket-service.js";
import type {
  WebSocketConnection,
  WebSocketMessage,
  WebSocketServer,
} from "../../src/platform/websocket/websocket-service.js";

const protocol = "sandbox-test.v1";
const maxMessageBytes = 32 * 1024 * 1024;

async function nextValue<T>(values: AsyncIterable<T>): Promise<T> {
  const result = await values[Symbol.asyncIterator]().next();
  if (result.done) throw new Error("The asynchronous resource ended early.");
  return result.value;
}

async function startAcceptedServer(
  options: {
    readonly maxBytes?: number;
    readonly signal?: AbortSignal;
    readonly authorizeUpgrade?: Parameters<
      ReturnType<typeof createNodeWebSocketService>["startServer"]
    >[0]["authorizeUpgrade"];
  } = {},
): Promise<WebSocketServer> {
  return createNodeWebSocketService().startServer({
    host: "127.0.0.1",
    port: 0,
    protocol,
    maxMessageBytes: options.maxBytes ?? maxMessageBytes,
    signal: options.signal,
    authorizeUpgrade: options.authorizeUpgrade ?? (() => ({ accepted: true })),
  });
}

async function connectTo(
  server: WebSocketServer,
): Promise<WebSocketConnection> {
  return createNodeWebSocketService().connect({
    url: `ws://${server.endpoint.host}:${server.endpoint.port}/session`,
    protocol,
    maxMessageBytes,
  });
}

async function verifyMessageExchange(): Promise<void> {
  await using server = await startAcceptedServer();
  await using client = await connectTo(server);
  await using accepted = await nextValue(server.connections);

  await client.sendText("first");
  await client.sendBinary(Uint8Array.of(1, 2, 3));
  assert.deepEqual(await nextValue(accepted.messages), {
    type: "text",
    data: "first",
  });
  const binary = await nextValue(accepted.messages);
  assert.equal(binary.type, "binary");
  assert.deepEqual(
    [...(binary as Extract<WebSocketMessage, { type: "binary" }>).data],
    [1, 2, 3],
  );

  await accepted.sendText("last");
  assert.deepEqual(await nextValue(client.messages), {
    type: "text",
    data: "last",
  });
}

async function verifyBackpressure(): Promise<void> {
  await using server = await startAcceptedServer();
  await using client = await connectTo(server);
  await using accepted = await nextValue(server.connections);
  const payload = new Uint8Array(16 * 1024 * 1024);
  let completed = false;

  const sending = client.sendBinary(payload).then(() => {
    completed = true;
  });
  await Promise.resolve();
  assert.equal(completed, false);
  const receiving = nextValue(accepted.messages);
  await sending;
  assert.equal((await receiving).type, "binary");
}

async function verifyProtocolDetails(): Promise<void> {
  let extensionHeader: string | readonly string[] | undefined;
  await using server = await startAcceptedServer({
    authorizeUpgrade: (metadata) => {
      extensionHeader = metadata.headers["sec-websocket-extensions"];
      return { accepted: true };
    },
  });
  await using client = await connectTo(server);
  await using accepted = await nextValue(server.connections);

  assert.equal(extensionHeader, undefined);
  assert.equal(client.protocol, protocol);
  assert.equal(accepted.protocol, protocol);
  const closing = client.close(4000, "complete");
  const expectedClose = { code: 4000, reason: "complete", wasClean: true };
  assert.deepEqual(await accepted.closed, expectedClose);
  assert.deepEqual(await closing, expectedClose);
  assert.deepEqual(await accepted.messages[Symbol.asyncIterator]().next(), {
    done: true,
    value: undefined,
  });
}

async function verifyMessageLimit(): Promise<void> {
  await using server = await startAcceptedServer({ maxBytes: 8 });
  await using client = await connectTo(server);
  await using accepted = await nextValue(server.connections);

  await client.sendBinary(new Uint8Array(9));
  assert.equal((await client.closed).code, 1009);
  assert.equal((await accepted.closed).code, 1009);
}

async function verifyAbortedSend(): Promise<void> {
  await using server = await startAcceptedServer();
  await using client = await connectTo(server);
  await using accepted = await nextValue(server.connections);
  const sendAbort = new AbortController();
  sendAbort.abort();
  await assert.rejects(
    client.sendText("not sent", { signal: sendAbort.signal }),
    {
      name: "AbortError",
    },
  );
  assert.equal(accepted.protocol, protocol);
}

async function verifyServerAbort(): Promise<void> {
  const controller = new AbortController();
  await using server = await startAcceptedServer({ signal: controller.signal });
  await using client = await connectTo(server);
  await using accepted = await nextValue(server.connections);

  controller.abort();
  assert.equal((await client.closed).code, 1006);
  assert.equal((await accepted.closed).code, 1006);
  await assert.rejects(connectTo(server));
}

await verifyMessageExchange();
await verifyBackpressure();
await verifyProtocolDetails();
await verifyMessageLimit();
await verifyAbortedSend();
await verifyServerAbort();
