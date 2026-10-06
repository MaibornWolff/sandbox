import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import { x11Error } from "./operation.js";

export function words(...values: number[]): Buffer {
  const data = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => {
    data.writeUInt32LE(value >>> 0, index * 4);
  });
  return data;
}

export function request(
  opcode: number,
  detail: number,
  body: Uint8Array,
): Buffer {
  const result = Buffer.alloc(4 + Math.ceil(body.length / 4) * 4);
  result[0] = opcode;
  result[1] = detail;
  result.writeUInt16LE(result.length / 4, 2);
  result.set(body, 4);
  return result;
}

interface PendingReply {
  resolve(data: Buffer): void;
  reject(error: Error): void;
}

export class XConnection implements AsyncDisposable {
  private sequence = 0;
  private nextResource = 0;
  private readonly chunks: Buffer[] = [];
  private buffered = 0;
  private readonly replies = new Map<number, PendingReply>();
  private readonly listeners = new Set<(event: Buffer) => void>();
  private setup: PendingReply | undefined;
  private closed = false;
  private resourceBase = 0;
  private resourceMask = 0;
  root = 0;
  readonly completion: Promise<void>;
  private complete: () => void = () => undefined;

  private constructor(private readonly socket: Duplex) {
    this.completion = new Promise((resolve) => {
      this.complete = resolve;
    });
    socket.on("data", (data: Buffer) => this.receive(data));
    socket.on("error", () =>
      this.fail(x11Error("connection-failed", "Private X11 connection failed")),
    );
    socket.on("close", () =>
      this.fail(x11Error("connection-closed", "Private X11 connection closed")),
    );
  }

  static async connect(
    display: number,
    cookie: Buffer,
    signal: AbortSignal,
  ): Promise<XConnection> {
    signal.throwIfAborted();
    const socket = createConnection({ path: `/tmp/.X11-unix/X${display}` });
    return XConnection.authenticate(socket, cookie, signal);
  }

  static async authenticate(
    socket: Duplex,
    cookie: Buffer,
    signal: AbortSignal,
  ): Promise<XConnection> {
    const connection = new XConnection(socket);
    const cancel = () => socket.destroy();
    signal.addEventListener("abort", cancel, { once: true });
    socket.once("close", () => signal.removeEventListener("abort", cancel));
    const setup = new Promise<Buffer>((resolve, reject) => {
      connection.setup = { resolve, reject };
    });
    const name = Buffer.from("MIT-MAGIC-COOKIE-1");
    const hello = Buffer.alloc(12 + 20 + cookie.length);
    hello[0] = 108;
    hello.writeUInt16LE(11, 2);
    hello.writeUInt16LE(name.length, 6);
    hello.writeUInt16LE(cookie.length, 8);
    hello.set(name, 12);
    hello.set(cookie, 32);
    socket.write(hello);
    const data = await setup;
    signal.removeEventListener("abort", cancel);
    if (data[0] !== 1) {
      socket.destroy();
      throw x11Error(
        "authentication-failed",
        "Private X11 authentication failed",
      );
    }
    connection.resourceBase = data.readUInt32LE(12);
    connection.resourceMask = data.readUInt32LE(16);
    const vendorLength = data.readUInt16LE(24);
    const formats = data[29] ?? 0;
    const screenOffset = 40 + Math.ceil(vendorLength / 4) * 4 + formats * 8;
    connection.root = data.readUInt32LE(screenOffset);
    return connection;
  }

  allocate(): number {
    this.nextResource++;
    if ((this.nextResource & this.resourceMask) !== this.nextResource)
      throw new Error("X11 resource limit reached");
    return (this.resourceBase | this.nextResource) >>> 0;
  }

  send(opcode: number, detail: number, body: Uint8Array): void {
    if (this.closed)
      throw x11Error("connection-closed", "Private X11 connection closed");
    this.sequence = (this.sequence + 1) & 0xffff;
    this.socket.write(request(opcode, detail, body));
  }

  reply(opcode: number, detail: number, body: Uint8Array): Promise<Buffer> {
    if (this.closed)
      return Promise.reject(
        x11Error("connection-closed", "Private X11 connection closed"),
      );
    const sequence = (this.sequence + 1) & 0xffff;
    const result = new Promise<Buffer>((resolve, reject) =>
      this.replies.set(sequence, { resolve, reject }),
    );
    this.send(opcode, detail, body);
    return result;
  }

  subscribe(listener: (event: Buffer) => void): Disposable {
    this.listeners.add(listener);
    return {
      [Symbol.dispose]: () => {
        this.listeners.delete(listener);
      },
    };
  }

  private receive(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    while (this.buffered >= 8) {
      const size = this.packetSize(this.prefix());
      if (size > 64 * 1024 * 1024) {
        this.fail(new Error("X11 reply exceeds size limit"));
        return;
      }
      if (this.buffered < size) return;
      this.dispatch(this.take(size));
    }
  }

  private prefix(): Buffer {
    const first = this.chunks[0];
    if (first && first.length >= 8) return first;
    const header = Buffer.alloc(8);
    let offset = 0;
    for (const chunk of this.chunks) {
      offset += chunk.copy(header, offset);
      if (offset === 8) break;
    }
    return header;
  }

  private take(size: number): Buffer {
    const result = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const chunk = this.chunks[0];
      if (!chunk) throw new Error("Incomplete X11 packet");
      const copied = chunk.copy(result, offset, 0, size - offset);
      offset += copied;
      if (copied === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(copied);
    }
    this.buffered -= size;
    return result;
  }

  private packetSize(header: Buffer): number {
    if (this.setup) return 8 + header.readUInt16LE(6) * 4;
    if (header[0] === 1) return 32 + header.readUInt32LE(4) * 4;
    return 32;
  }

  private dispatch(data: Buffer): void {
    if (this.setup) {
      const setup = this.setup;
      this.setup = undefined;
      setup.resolve(data);
      return;
    }
    if (data[0] === 0 || data[0] === 1) {
      const sequence = data.readUInt16LE(2);
      const pending = this.replies.get(sequence);
      this.replies.delete(sequence);
      if (pending) {
        if (data[0] === 0)
          pending.reject(
            x11Error(`request-${data[1]}`, `X11 request failed (${data[1]})`),
          );
        else pending.resolve(data);
        return;
      }
    }
    for (const listener of this.listeners) listener(data);
  }

  private fail(error: Error): void {
    this.closed = true;
    this.setup?.reject(error);
    this.setup = undefined;
    for (const pending of this.replies.values()) pending.reject(error);
    this.replies.clear();
    this.chunks.length = 0;
    this.buffered = 0;
    this.socket.destroy();
    this.complete();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.fail(new Error("Private X11 session disposed"));
    await this.completion;
  }
}
