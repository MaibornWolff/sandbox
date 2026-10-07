import { abortable, x11Error } from "./operation.js";
import { words, type XConnection } from "./protocol.js";

export type SelectionConnection = Pick<
  XConnection,
  "root" | "allocate" | "send" | "reply" | "subscribe"
>;
export const MAX_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
export const PROPERTY_EVENTS = 1 << 22;
export const STRUCTURE_EVENTS = 1 << 17;
const ATOM_NAMES = [
  "CLIPBOARD",
  "TARGETS",
  "UTF8_STRING",
  "text/plain;charset=utf-8",
  "text/plain",
  "image/png",
  "TIMESTAMP",
  "INCR",
  "SANDBOX_CLIPBOARD",
] as const;
export const TEXT_TARGET_NAMES = [
  "UTF8_STRING",
  "text/plain;charset=utf-8",
  "text/plain",
] as const;
type AtomName = (typeof ATOM_NAMES)[number];
export type Atoms = Record<AtomName, number>;

export async function intern(connection: SelectionConnection): Promise<Atoms> {
  const entries = await Promise.all(
    ATOM_NAMES.map(async (name) => {
      const text = Buffer.from(name);
      const body = Buffer.alloc(4 + text.length);
      body.writeUInt16LE(text.length);
      body.set(text, 4);
      return [
        name,
        (await connection.reply(16, 0, body)).readUInt32LE(8),
      ] as const;
    }),
  );
  return Object.fromEntries(entries) as Atoms;
}

export function createWindow(connection: SelectionConnection): number {
  const window = connection.allocate();
  const body = Buffer.alloc(32);
  body.writeUInt32LE(window);
  body.writeUInt32LE(connection.root, 4);
  body.writeUInt16LE(1, 12);
  body.writeUInt16LE(1, 14);
  body.writeUInt16LE(2, 18);
  body.writeUInt32LE(1 << 11, 24);
  body.writeUInt32LE(PROPERTY_EVENTS | STRUCTURE_EVENTS, 28);
  connection.send(1, 0, body);
  return window;
}

export function changeProperty(
  connection: SelectionConnection,
  options: {
    window: number;
    property: number;
    type: number;
    format: number;
    data: Buffer;
  },
): void {
  const header = Buffer.alloc(20);
  header.writeUInt32LE(options.window);
  header.writeUInt32LE(options.property, 4);
  header.writeUInt32LE(options.type, 8);
  header[12] = options.format;
  header.writeUInt32LE(options.data.length / (options.format / 8), 16);
  connection.send(18, 0, Buffer.concat([header, options.data]));
}

export function validTargets(targets: {
  type: number;
  format: number;
  data: Buffer;
}): boolean {
  return (
    targets.type === 4 &&
    targets.format === 32 &&
    targets.data.length <= 64 * 1024 &&
    targets.data.length % 4 === 0
  );
}

export function requestorProperty(event: Buffer): number {
  return event.readUInt32LE(24) || event.readUInt32LE(20);
}

export function eventType(event: Buffer): number {
  return (event[0] ?? 0) & 127;
}

export function waitEvent(
  connection: SelectionConnection,
  predicate: (event: Buffer) => boolean,
  signal: AbortSignal,
) {
  let resolveEvent: (event: Buffer) => void = () => undefined;
  const result = new Promise<Buffer>((resolve) => {
    resolveEvent = resolve;
  });
  const subscription = connection.subscribe((event) => {
    if (predicate(event)) resolveEvent(event);
  });
  return {
    result: abortable(result, signal),
    [Symbol.dispose]: () => subscription[Symbol.dispose](),
  };
}

async function property(
  connection: SelectionConnection,
  window: number,
  atom: number,
) {
  const reply = await connection.reply(
    20,
    1,
    words(window, atom, 0, 0, MAX_BYTES / 4),
  );
  if (reply.readUInt32LE(12) !== 0)
    throw new Error("X11 clipboard exceeds size limit");
  const format = reply[1] ?? 0;
  const length = reply.readUInt32LE(16) * (format / 8);
  if (length > MAX_BYTES || length > reply.length - 32)
    throw new Error("Invalid X11 clipboard property");
  return {
    type: reply.readUInt32LE(8),
    format,
    data: reply.subarray(32, 32 + length),
  };
}

function validIncrementalHeader(initial: {
  format: number;
  data: Buffer;
}): boolean {
  // xclip omits the advisory size. Bound the bytes received instead.
  if (initial.format !== 32) return false;
  return (
    initial.data.length === 0 ||
    (initial.data.length === 4 && initial.data.readUInt32LE() <= MAX_BYTES)
  );
}

export async function receiveSelection(options: {
  connection: SelectionConnection;
  atoms: Atoms;
  target: number;
  timestamp: number;
  signal: AbortSignal;
}): Promise<{ data: Buffer; format: number; type: number }> {
  const { connection, atoms, target, timestamp, signal } = options;
  const window = createWindow(connection);
  using _window = {
    [Symbol.dispose]: () => connection.send(4, 0, words(window)),
  };
  using notify = waitEvent(
    connection,
    (event) => eventType(event) === 31 && event.readUInt32LE(8) === window,
    signal,
  );
  connection.send(
    24,
    0,
    words(window, atoms.CLIPBOARD, target, atoms.SANDBOX_CLIPBOARD, timestamp),
  );
  const event = await notify.result;
  if (event.readUInt32LE(20) === 0)
    throw x11Error("format-unavailable", "X11 clipboard format unavailable");
  using changes = propertyQueue(
    connection,
    window,
    atoms.SANDBOX_CLIPBOARD,
    signal,
  );
  const initial = await abortable(
    property(connection, window, atoms.SANDBOX_CLIPBOARD),
    signal,
  );
  if (initial.type !== atoms.INCR) return initial;
  if (!validIncrementalHeader(initial))
    throw x11Error("size-invalid", "Invalid X11 incremental transfer size");
  const chunks: Buffer[] = [];
  let size = 0;
  let format = 0;
  let type = 0;
  while (true) {
    await changes.next();
    const chunk = await abortable(
      property(connection, window, atoms.SANDBOX_CLIPBOARD),
      signal,
    );
    if (chunk.type === 0) continue;
    if (format && (format !== chunk.format || type !== chunk.type))
      throw x11Error(
        "format-changed",
        "X11 incremental transfer changed format",
      );
    format = chunk.format;
    type = chunk.type;
    if (chunk.data.length === 0)
      return { data: Buffer.concat(chunks, size), format, type };
    size += chunk.data.length;
    if (size > MAX_BYTES) throw new Error("X11 clipboard exceeds size limit");
    chunks.push(chunk.data);
  }
}

function propertyQueue(
  connection: SelectionConnection,
  window: number,
  atom: number,
  signal: AbortSignal,
  state = 0,
) {
  let pending = 0;
  let wake: (() => void) | undefined;
  const subscription = connection.subscribe((event) => {
    if (
      eventType(event) !== 28 ||
      event.readUInt32LE(4) !== window ||
      event.readUInt32LE(8) !== atom ||
      event[16] !== state
    )
      return;
    if (wake) {
      const resolve = wake;
      wake = undefined;
      resolve();
    } else pending = Math.min(pending + 1, 8);
  });
  return {
    async next(): Promise<void> {
      signal.throwIfAborted();
      if (pending) {
        pending--;
        return;
      }
      await abortable(
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
        signal,
      );
    },
    [Symbol.dispose]: () => subscription[Symbol.dispose](),
  };
}

export async function sendSelection(options: {
  connection: SelectionConnection;
  atoms: Atoms;
  event: Buffer;
  data: Buffer;
  type: number;
  format: number;
  signal: AbortSignal;
}) {
  const { connection, atoms, event, data, type, format, signal } = options;
  const window = event.readUInt32LE(12);
  const propertyAtom = requestorProperty(event);
  const write = (value: Buffer, propertyType = type, propertyFormat = format) =>
    changeProperty(connection, {
      window,
      property: propertyAtom,
      type: propertyType,
      format: propertyFormat,
      data: value,
    });
  if (data.length <= CHUNK_BYTES) {
    write(data);
    notifySelection(connection, event, propertyAtom);
    return;
  }
  using acknowledgements = propertyQueue(
    connection,
    window,
    propertyAtom,
    signal,
    1,
  );
  write(words(data.length), atoms.INCR, 32);
  notifySelection(connection, event, propertyAtom);
  for (let offset = 0; offset <= data.length; offset += CHUNK_BYTES) {
    await acknowledgements.next();
    write(data.subarray(offset, offset + CHUNK_BYTES));
    if (offset === data.length) {
      await acknowledgements.next();
      return;
    }
  }
  await acknowledgements.next();
  write(Buffer.alloc(0));
  await acknowledgements.next();
}

export function notifySelection(
  connection: SelectionConnection,
  event: Buffer,
  propertyAtom: number,
): void {
  const notification = Buffer.alloc(32);
  notification[0] = 31;
  event.copy(notification, 4, 4, 8);
  event.copy(notification, 8, 12, 24);
  notification.writeUInt32LE(propertyAtom, 20);
  connection.send(
    25,
    0,
    Buffer.concat([words(event.readUInt32LE(12), 0), notification]),
  );
}
