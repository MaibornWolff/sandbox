import { words } from "../protocol.js";
import type { SelectionConnection } from "../selection-wire.js";

interface Property {
  type: number;
  format: number;
  data: Buffer;
}
export class SelectionFixture implements SelectionConnection {
  readonly root = 1;
  readonly atoms = new Map<string, number>();
  readonly notifications: Buffer[] = [];
  readonly writes: { window: number; atom: number; property: Property }[] = [];
  readonly properties = new Map<string, Property>();
  readonly listeners = new Set<(event: Buffer) => void>();
  readonly destroyed: number[] = [];
  readonly incoming = new Map<number, Property>();
  readonly increments = new Map<string, { target: number; chunks: Buffer[] }>();
  owner = 0;
  proxy = 0;
  timestamp = 100;
  incremental = false;
  stall = false;
  private resource = 1000;
  allocate(): number {
    return ++this.resource;
  }
  atom(name: string): number {
    const existing = this.atoms.get(name);
    if (existing) return existing;
    const atom = 100 + this.atoms.size;
    this.atoms.set(name, atom);
    return atom;
  }
  subscribe(listener: (event: Buffer) => void): Disposable {
    this.listeners.add(listener);
    return {
      [Symbol.dispose]: () => {
        this.listeners.delete(listener);
      },
    };
  }
  emit(event: Buffer): void {
    for (const listener of this.listeners) listener(event);
  }
  propertyEvent(window: number, atom: number, state: number): void {
    const event = Buffer.alloc(32);
    event[0] = 28;
    words(window, atom, this.timestamp).copy(event, 4);
    event[16] = state;
    this.emit(event);
  }
  setOwner(owner: number): void {
    this.owner = owner;
    this.timestamp++;
    const event = Buffer.alloc(32);
    event[0] = 90;
    words(
      this.proxy,
      owner,
      this.atom("CLIPBOARD"),
      this.timestamp,
      this.timestamp,
    ).copy(event, 4);
    this.emit(event);
  }
  request(target: string, requestor = 2000, property = 3000): void {
    const event = Buffer.alloc(32);
    event[0] = 30;
    words(
      this.timestamp,
      this.owner,
      requestor,
      this.atom("CLIPBOARD"),
      this.atom(target),
      property,
    ).copy(event, 4);
    this.emit(event);
  }
  offer(formats: Record<string, Buffer>, owner = 4000): void {
    this.incoming.clear();
    this.incoming.set(this.atom("TARGETS"), {
      type: 4,
      format: 32,
      data: words(...Object.keys(formats).map((name) => this.atom(name))),
    });
    for (const [name, data] of Object.entries(formats))
      this.incoming.set(this.atom(name), {
        type: this.atom(name),
        format: 8,
        data,
      });
    this.setOwner(owner);
  }
  send(opcode: number, _detail: number, value: Uint8Array): void {
    const body = Buffer.from(value);
    if (opcode === 1 && !this.proxy) this.proxy = body.readUInt32LE();
    if (opcode === 4) this.destroyed.push(body.readUInt32LE());
    if (opcode === 18) {
      const window = body.readUInt32LE();
      const atom = body.readUInt32LE(4);
      const format = body[12] ?? 0;
      const property = {
        type: body.readUInt32LE(8),
        format,
        data: Buffer.from(
          body.subarray(20, 20 + (body.readUInt32LE(16) * format) / 8),
        ),
      };
      this.properties.set(`${window}:${atom}`, property);
      this.writes.push({ window, atom, property });
      this.propertyEvent(window, atom, 0);
    }
    if (opcode === 22) this.setOwner(body.readUInt32LE());
    if (opcode === 25) this.notifications.push(body.subarray(8));
    if (opcode === 24) this.convert(body);
  }
  private convert(body: Buffer): void {
    if (this.stall) return;
    const window = body.readUInt32LE();
    const target = body.readUInt32LE(8);
    const atom = body.readUInt32LE(12);
    const value = this.incoming.get(target);
    if (value) {
      const key = `${window}:${atom}`;
      if (this.incremental && value.format === 8) {
        const chunks: Buffer[] = [];
        for (let offset = 0; offset < value.data.length; offset += 16_384)
          chunks.push(value.data.subarray(offset, offset + 16_384));
        chunks.push(Buffer.alloc(0));
        this.increments.set(key, { target, chunks });
        this.properties.set(key, {
          type: this.atom("INCR"),
          format: 32,
          data: words(value.data.length),
        });
      } else this.properties.set(key, value);
    }
    const event = Buffer.alloc(32);
    event[0] = 31;
    words(
      this.timestamp,
      window,
      this.atom("CLIPBOARD"),
      target,
      value ? atom : 0,
    ).copy(event, 4);
    this.emit(event);
  }
  async reply(
    opcode: number,
    _detail: number,
    value: Uint8Array,
  ): Promise<Buffer> {
    const body = Buffer.from(value);
    const reply = Buffer.alloc(32);
    reply[0] = 1;
    if (opcode === 16)
      reply.writeUInt32LE(
        this.atom(body.subarray(4, 4 + body.readUInt16LE()).toString()),
        8,
      );
    if (opcode === 98) {
      reply[8] = 1;
      reply[9] = 140;
      reply[10] = 90;
    }
    if (opcode === 23) reply.writeUInt32LE(this.owner, 8);
    if (opcode === 20) return this.getProperty(body);
    return reply;
  }
  private getProperty(body: Buffer): Buffer {
    const window = body.readUInt32LE();
    const atom = body.readUInt32LE(4);
    const key = `${window}:${atom}`;
    const property = this.properties.get(key);
    const reply = Buffer.alloc(32);
    reply[0] = 1;
    if (!property) return reply;
    reply[1] = property.format;
    reply.writeUInt32LE(property.type, 8);
    reply.writeUInt32LE(property.data.length / (property.format / 8), 16);
    this.properties.delete(key);
    this.propertyEvent(window, atom, 1);
    const transfer = this.increments.get(key);
    const chunk = transfer?.chunks.shift();
    if (transfer && chunk) {
      this.properties.set(key, {
        type: transfer.target,
        format: 8,
        data: chunk,
      });
      this.propertyEvent(window, atom, 0);
    }
    return Buffer.concat([reply, property.data]);
  }
}

export async function settle(): Promise<void> {
  for (let iteration = 0; iteration < 100; iteration++) await Promise.resolve();
}
