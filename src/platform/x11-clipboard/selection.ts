import type { Clock } from "#platform/clock/index.js";
import { deadline, X11Error, x11Error } from "./operation.js";
import { words } from "./protocol.js";
import {
  type Atoms,
  changeProperty,
  createWindow,
  eventType,
  intern,
  MAX_BYTES,
  notifySelection,
  PROPERTY_EVENTS,
  receiveSelection,
  requestorProperty,
  type SelectionConnection,
  STRUCTURE_EVENTS,
  sendSelection,
  TEXT_TARGET_NAMES,
  validTargets,
  waitEvent,
} from "./selection-wire.js";

export type X11ClipboardFormat = "text/plain" | "image/png";
export interface X11ClipboardOptions {
  discover(signal: AbortSignal): Promise<readonly X11ClipboardFormat[]>;
  read(format: X11ClipboardFormat, signal: AbortSignal): Promise<Uint8Array>;
  publish(
    item: { format: X11ClipboardFormat; data: Uint8Array; generation: number },
    signal: AbortSignal,
  ): Promise<void>;
  onError(error: Error): void;
  signal?: AbortSignal;
}

const MAX_ACTIVE_REQUESTS = 4;
const TRANSFER_CODES = new Set([
  "timeout",
  "format-changed",
  "size-invalid",
  "targets-invalid",
  "type-invalid",
  "format-unavailable",
]);

function transferCode(error: unknown): string {
  if (error instanceof X11Error && TRANSFER_CODES.has(error.code))
    return `transfer-${error.code}`;
  return "transfer-failed";
}

export class ClipboardSelection implements AsyncDisposable {
  private readonly cancellation = new AbortController();
  private readonly jobs = new Set<Promise<void>>();
  private readonly activeRequests = new Set<string>();
  private generation = 0;
  private ownershipTime = 0;
  private copyCancellation: AbortController | undefined;
  private subscription: Disposable | undefined;
  private readonly signal: AbortSignal;
  private readonly textTargets: readonly number[];
  private constructor(
    private readonly connection: SelectionConnection,
    private readonly clock: Clock,
    private readonly options: X11ClipboardOptions,
    private readonly atoms: Atoms,
    private readonly window: number,
    private readonly fixesEvent: number,
  ) {
    this.signal = options.signal
      ? AbortSignal.any([options.signal, this.cancellation.signal])
      : this.cancellation.signal;
    this.textTargets = TEXT_TARGET_NAMES.map((name) => atoms[name]);
  }

  static async open(
    connection: SelectionConnection,
    clock: Clock,
    options: X11ClipboardOptions,
  ): Promise<ClipboardSelection> {
    const atoms = await intern(connection);
    const query = Buffer.alloc(10);
    query.writeUInt16LE(6);
    query.write("XFIXES", 4);
    const extension = await connection.reply(98, 0, query);
    if (!extension[8])
      throw x11Error("xfixes-unavailable", "Private X11 server lacks XFixes");
    const opcode = extension[9] ?? 0;
    await connection.reply(opcode, 0, words(5, 0));
    const window = createWindow(connection);
    const selection = new ClipboardSelection(
      connection,
      clock,
      options,
      atoms,
      window,
      extension[10] ?? 0,
    );
    connection.send(opcode, 2, words(window, atoms.CLIPBOARD, 7));
    selection.subscription = connection.subscribe((event) =>
      selection.event(event),
    );
    await deadline({
      clock,
      signal: selection.signal,
      milliseconds: 3_000,
      run: async (signal) => {
        using timestamp = waitEvent(
          connection,
          (event) =>
            eventType(event) === 28 && event.readUInt32LE(4) === window,
          signal,
        );
        changeProperty(connection, {
          window,
          property: atoms.SANDBOX_CLIPBOARD,
          type: 19,
          format: 8,
          data: Buffer.alloc(0),
        });
        selection.claim((await timestamp.result).readUInt32LE(12));
        if (
          (await connection.reply(23, 0, words(atoms.CLIPBOARD))).readUInt32LE(
            8,
          ) !== window
        )
          throw x11Error(
            "selection-failed",
            "Cannot own private X11 clipboard",
          );
      },
    });
    return selection;
  }

  private claim(timestamp: number): void {
    this.ownershipTime = timestamp;
    this.connection.send(
      22,
      0,
      words(this.window, this.atoms.CLIPBOARD, timestamp),
    );
  }

  private track(work: Promise<void>, signal = this.signal): void {
    const job = work.catch((error: unknown) => {
      if (!signal.aborted)
        this.options.onError(
          Object.assign(new Error("Private X11 clipboard transfer failed"), {
            code: transferCode(error),
          }),
        );
    });
    this.jobs.add(job);
    void job.then(() => this.jobs.delete(job));
  }

  private event(event: Buffer): void {
    if (this.signal.aborted) return;
    if (eventType(event) === 0) {
      this.options.onError(
        new Error(`Private X11 request failed (${event[1]})`),
      );
      return;
    }
    if (
      eventType(event) === 30 &&
      event.readUInt32LE(16) === this.atoms.CLIPBOARD
    ) {
      this.request(event);
    }
    if (
      eventType(event) === this.fixesEvent &&
      event.readUInt32LE(12) === this.atoms.CLIPBOARD
    ) {
      const owner = event.readUInt32LE(8);
      if (owner === this.window) return;
      this.generation++;
      this.copyCancellation?.abort();
      if (!owner || event[1] === 1 || event[1] === 2) {
        this.claim(event.readUInt32LE(16));
        return;
      }
      this.copyCancellation = new AbortController();
      const signal = AbortSignal.any([
        this.signal,
        this.copyCancellation.signal,
      ]);
      this.track(
        this.capture({
          owner,
          timestamp: event.readUInt32LE(20),
          generation: this.generation,
          signal,
        }),
        signal,
      );
    }
  }

  private request(event: Buffer): void {
    const requestedAt = event.readUInt32LE(4);
    if (requestedAt !== 0 && ((requestedAt - this.ownershipTime) | 0) < 0) {
      notifySelection(this.connection, event, 0);
      return;
    }
    const key = `${event.readUInt32LE(12)}:${requestorProperty(event)}`;
    if (
      this.activeRequests.size >= MAX_ACTIVE_REQUESTS ||
      this.activeRequests.has(key)
    ) {
      notifySelection(this.connection, event, 0);
      return;
    }
    this.activeRequests.add(key);
    this.track(
      this.serve(event).finally(() => {
        this.activeRequests.delete(key);
      }),
    );
  }

  private async serve(event: Buffer): Promise<void> {
    let delivering = false;
    const requestor = new AbortController();
    using _requestor = this.connection.subscribe((message) => {
      if (
        eventType(message) === 17 &&
        message.readUInt32LE(8) === event.readUInt32LE(12)
      )
        requestor.abort();
    });
    this.connection.send(
      2,
      0,
      words(
        event.readUInt32LE(12),
        1 << 11,
        PROPERTY_EVENTS | STRUCTURE_EVENTS,
      ),
    );
    try {
      await deadline({
        clock: this.clock,
        signal: AbortSignal.any([this.signal, requestor.signal]),
        milliseconds: 10_000,
        run: async (signal) => {
          const payload = await deadline({
            clock: this.clock,
            signal,
            milliseconds: 3_500,
            run: (readSignal) =>
              this.payload(event.readUInt32LE(20), readSignal),
          });
          signal.throwIfAborted();
          delivering = true;
          await sendSelection({
            connection: this.connection,
            atoms: this.atoms,
            event,
            ...payload,
            signal,
          });
        },
      });
    } catch (error) {
      if (!delivering && !this.signal.aborted && !requestor.signal.aborted)
        notifySelection(this.connection, event, 0);
      throw error;
    }
  }

  private async payload(
    target: number,
    signal: AbortSignal,
  ): Promise<{ data: Buffer; type: number; format: number }> {
    if (target === this.atoms.TIMESTAMP)
      return { data: words(this.ownershipTime), type: 19, format: 32 };
    if (target === this.atoms.TARGETS) {
      const formats = await this.options.discover(signal);
      const targets = [this.atoms.TARGETS, this.atoms.TIMESTAMP];
      if (formats.includes("text/plain")) targets.push(...this.textTargets);
      if (formats.includes("image/png")) targets.push(this.atoms["image/png"]);
      return { data: words(...targets), type: 4, format: 32 };
    }
    const format = this.formatOfTarget(target);
    if (!format) throw new Error("X11 clipboard target unsupported");
    const bytes = await this.options.read(format, signal);
    if (bytes.length > MAX_BYTES)
      throw new Error("X11 clipboard exceeds size limit");
    return { data: Buffer.from(bytes), type: target, format: 8 };
  }

  private formatOfTarget(target: number): X11ClipboardFormat | undefined {
    if (target === this.atoms["image/png"]) return "image/png";
    return this.textTargets.includes(target) ? "text/plain" : undefined;
  }

  private async capture(copy: {
    owner: number;
    timestamp: number;
    generation: number;
    signal: AbortSignal;
  }): Promise<void> {
    await deadline({
      clock: this.clock,
      signal: copy.signal,
      milliseconds: 10_000,
      run: async (signal) => {
        const read = (target: number) =>
          receiveSelection({
            connection: this.connection,
            atoms: this.atoms,
            target,
            timestamp: copy.timestamp,
            signal,
          });
        const targets = await read(this.atoms.TARGETS);
        if (!validTargets(targets))
          throw x11Error("targets-invalid", "Invalid X11 clipboard targets");
        const offered = new Set<number>();
        for (let offset = 0; offset < targets.data.length; offset += 4)
          offered.add(targets.data.readUInt32LE(offset));
        const target = [this.atoms["image/png"], ...this.textTargets].find(
          (atom) => offered.has(atom),
        );
        if (!target) throw new Error("X11 clipboard has no supported format");
        const item = await read(target);
        if (item.format !== 8 || item.type !== target)
          throw x11Error("type-invalid", "Invalid X11 clipboard data type");
        signal.throwIfAborted();
        if (!(await this.current(copy))) return;
        await this.options.publish(
          {
            format: this.formatOfTarget(target) ?? "text/plain",
            data: item.data,
            generation: copy.generation,
          },
          signal,
        );
        signal.throwIfAborted();
        if (await this.current(copy)) this.claim(copy.timestamp);
      },
    });
  }

  private async current(copy: {
    owner: number;
    generation: number;
  }): Promise<boolean> {
    const owner = await this.connection.reply(
      23,
      0,
      words(this.atoms.CLIPBOARD),
    );
    return (
      copy.generation === this.generation &&
      owner.readUInt32LE(8) === copy.owner
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.cancellation.abort();
    this.subscription?.[Symbol.dispose]();
    await Promise.allSettled(this.jobs);
  }
}
