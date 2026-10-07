import { expect, test } from "bun:test";
import { Duplex } from "node:stream";
import { request, words, XConnection } from "./protocol.js";

class Wire extends Duplex {
  readonly sent: Buffer[] = [];
  override _read(): void {}
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.sent.push(Buffer.from(chunk));
    callback();
  }
}

function setup(): Buffer {
  const reply = Buffer.alloc(80);
  reply[0] = 1;
  reply.writeUInt16LE(18, 6);
  reply.writeUInt32LE(0x200000, 12);
  reply.writeUInt32LE(0x1fffff, 16);
  reply[28] = 1;
  reply.writeUInt32LE(99, 40);
  return reply;
}

async function connect() {
  const wire = new Wire();
  const pending = XConnection.authenticate(
    wire,
    Buffer.alloc(16, 12),
    new AbortController().signal,
  );
  wire.push(setup().subarray(0, 10));
  wire.push(setup().subarray(10));
  return { wire, connection: await pending };
}

test("authenticates binary X11 setup and allocates connection resource IDs", async () => {
  const { wire, connection } = await connect();
  await using _connection = connection;
  const hello = wire.sent[0];
  expect(hello?.[0]).toBe(108);
  expect(hello?.subarray(12, 30).toString()).toBe("MIT-MAGIC-COOKIE-1");
  expect(hello?.subarray(32)).toEqual(Buffer.alloc(16, 12));
  expect(connection.root).toBe(99);
  expect(connection.allocate()).toBe(0x200001);
  expect(connection.allocate()).toBe(0x200002);
});

test("matches replies by sequence, decodes fragmented packets and forwards events", async () => {
  const { wire, connection } = await connect();
  await using _connection = connection;
  const events: Buffer[] = [];
  using _events = connection.subscribe((event) => events.push(event));
  const first = connection.reply(23, 0, words(100));
  const second = connection.reply(23, 0, words(101));
  const reply = Buffer.alloc(32);
  reply[0] = 1;
  reply.writeUInt16LE(2, 2);
  reply.writeUInt32LE(456, 8);
  wire.push(reply.subarray(0, 5));
  wire.push(reply.subarray(5));
  expect((await second).readUInt32LE(8)).toBe(456);
  const event = Buffer.alloc(32);
  event[0] = 28;
  const firstReply = Buffer.from(reply);
  firstReply.writeUInt16LE(1, 2);
  wire.push(Buffer.concat([event, firstReply]));
  await first;
  expect(events).toEqual([event]);
});

test("fails pending replies on X11 errors and connection exit", async () => {
  const { wire, connection } = await connect();
  await using _connection = connection;
  const pending = connection.reply(20, 0, words(100));
  const error = Buffer.alloc(32);
  error[1] = 3;
  error.writeUInt16LE(1, 2);
  wire.push(error);
  await expect(pending).rejects.toThrow("X11 request failed (3)");
  const interrupted = connection.reply(20, 0, words(100));
  wire.destroy();
  await expect(interrupted).rejects.toThrow("Private X11 connection closed");
  await connection.completion;
});

test("pads native requests to four bytes", () => {
  expect(request(16, 0, Buffer.from([1, 2, 3]))).toEqual(
    Buffer.from([16, 0, 2, 0, 1, 2, 3, 0]),
  );
});
