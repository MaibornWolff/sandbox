import type { HostBridgeCapability } from "#modules/host-bridge/index.js";
import {
  createDependency,
  type DependencyBinding,
} from "#platform/dependency-injection/index.js";
import { getLogger } from "#platform/logging/index.js";
import {
  isNativeClipboardFormat,
  NativeClipboardError,
  type NativeClipboardService,
} from "#platform/native-clipboard/index.js";
import type {
  WebSocketConnection,
  WebSocketMessage,
} from "#platform/websocket/index.js";
import {
  CLIPBOARD_READ,
  CLIPBOARD_WRITE,
  expectControl,
  isUint,
  nextMessage,
  parseControl,
  protocolError,
  receivePayload,
  sendControl,
  sendPayload,
  validateContent,
  validateLength,
} from "./protocol.js";
import {
  createSlotLimiter,
  MAX_CONCURRENT_TRANSFERS,
  withClipboardDeadline,
} from "./request-scope.js";

export interface ClipboardCapabilities extends AsyncDisposable {
  readonly capabilities: readonly HostBridgeCapability[];
}

export interface ClipboardCapabilityFactory {
  create(): ClipboardCapabilities;
}

const MAX_REQUEST_ID = 0xffff_ffff;

interface ParsedRequest {
  readonly request: Record<string, unknown>;
  readonly id: number;
}

/** Parses the first message. Answers probes and returns undefined for them. */
async function readFirstRequest(
  connection: WebSocketConnection,
  iterator: AsyncIterator<WebSocketMessage>,
  signal: AbortSignal,
): Promise<ParsedRequest | undefined> {
  const request = parseControl(await nextMessage(iterator));
  const id = request.id;
  if (!isUint(id, { min: 1, max: MAX_REQUEST_ID })) throw protocolError();
  if (request.type !== "probe") return { request, id };
  expectControl(request, "probe", id, []);
  await sendControl(connection, { type: "ready", id }, signal);
  return undefined;
}

async function handleRead(
  native: NativeClipboardService,
  connection: WebSocketConnection,
  signal: AbortSignal,
): Promise<void> {
  const iterator = connection.messages[Symbol.asyncIterator]();
  const first = await readFirstRequest(connection, iterator, signal);
  if (!first) return;
  const { request, id } = first;
  if (request.type === "discover") {
    expectControl(request, "discover", id, []);
    const formats = await native.discover({ signal });
    if (!formats.every(isNativeClipboardFormat)) throw protocolError();
    await sendControl(
      connection,
      { type: "formats", id, formats: [...new Set(formats)] },
      signal,
    );
    return;
  }
  expectControl(request, "read", id, ["format"]);
  if (!isNativeClipboardFormat(request.format)) throw protocolError();
  const data = await native.read(request.format, { signal });
  validateContent(request.format, data);
  await sendControl(
    connection,
    { type: "content", id, format: request.format, bytes: data.length },
    signal,
  );
  await sendPayload(connection, id, data, signal);
}

function failureCode(error: unknown): string {
  return error instanceof NativeClipboardError ? error.code : "transfer-failed";
}

/** A newer copy aborts the previous one and closes its connection. */
function createCopySupersession() {
  let generation = 0;
  let current: AbortController | undefined;
  return {
    isNewer(value: unknown): value is number {
      return isUint(value, {
        min: generation + 1,
        max: Number.MAX_SAFE_INTEGER,
      });
    },
    isCurrent(value: number): boolean {
      return generation === value;
    },
    begin(
      next: number,
      connection: WebSocketConnection,
      signal: AbortSignal,
    ): { readonly signal: AbortSignal } & Disposable {
      generation = next;
      current?.abort();
      const copy = new AbortController();
      current = copy;
      const close = () => {
        void connection.close(1000, "Copy superseded");
      };
      copy.signal.addEventListener("abort", close, { once: true });
      return {
        signal: AbortSignal.any([signal, copy.signal]),
        [Symbol.dispose]() {
          copy.signal.removeEventListener("abort", close);
        },
      };
    },
    abort(): void {
      current?.abort();
    },
  };
}

type CopySupersession = ReturnType<typeof createCopySupersession>;

async function receivePublish(options: {
  readonly native: NativeClipboardService;
  readonly connection: WebSocketConnection;
  readonly signal: AbortSignal;
  readonly supersession: CopySupersession;
  readonly reserve: () => Disposable;
}): Promise<void> {
  const { native, connection, supersession } = options;
  const iterator = connection.messages[Symbol.asyncIterator]();
  const first = await readFirstRequest(connection, iterator, options.signal);
  if (!first) return;
  const { request, id } = first;
  expectControl(request, "publish", id, ["format", "bytes", "generation"]);
  const { format, generation } = request;
  if (!isNativeClipboardFormat(format) || !supersession.isNewer(generation))
    throw protocolError();
  validateLength(format, request.bytes);
  using copy = supersession.begin(generation, connection, options.signal);
  using _slot = options.reserve();
  await sendControl(connection, { type: "accepted", id }, copy.signal);
  const data = await receivePayload(iterator, {
    id,
    format,
    bytes: request.bytes,
    signal: copy.signal,
  });
  copy.signal.throwIfAborted();
  if (!supersession.isCurrent(generation)) throw protocolError();
  getLogger().debug(`Publishing clipboard ${format}, ${data.length} bytes`);
  await native.publish({ format, data }, { signal: copy.signal });
  await sendControl(connection, { type: "published", id }, copy.signal);
}

export function createClipboardCapabilityFactory(
  native: NativeClipboardService,
): ClipboardCapabilityFactory {
  const busy = () => new NativeClipboardError("busy");
  const reserveRead = createSlotLimiter(MAX_CONCURRENT_TRANSFERS, busy);
  const reserveWrite = createSlotLimiter(MAX_CONCURRENT_TRANSFERS, busy);
  return {
    create() {
      const controller = new AbortController();
      const supersession = createCopySupersession();
      const tasks = new Set<Promise<void>>();
      const execute = (
        connection: WebSocketConnection,
        context: { readonly signal: AbortSignal },
        operation: (signal: AbortSignal) => Promise<void>,
      ) => {
        const signal = AbortSignal.any([context.signal, controller.signal]);
        const task = withClipboardDeadline(connection, signal, operation).catch(
          async (error: unknown) => {
            const code = failureCode(error);
            getLogger().warn(`Clipboard operation failed: ${code}.`);
            if (!signal.aborted)
              await connection
                .sendText(JSON.stringify({ type: "error", code }))
                .catch(() => {});
          },
        );
        tasks.add(task);
        void task.then(() => tasks.delete(task));
        return task;
      };
      const read: HostBridgeCapability = {
        name: CLIPBOARD_READ,
        handle(connection, context) {
          return execute(connection, context, async (signal) => {
            using _slot = reserveRead();
            getLogger().debug("Reading current host clipboard");
            await handleRead(native, connection, signal);
          });
        },
      };
      const write: HostBridgeCapability = {
        name: CLIPBOARD_WRITE,
        handle(connection, context) {
          return execute(connection, context, (signal) =>
            receivePublish({
              native,
              connection,
              signal,
              supersession,
              reserve: reserveWrite,
            }),
          );
        },
      };
      return {
        capabilities: [read, write],
        async [Symbol.asyncDispose]() {
          controller.abort();
          supersession.abort();
          await Promise.all(tasks);
        },
      };
    },
  };
}

const dependency = createDependency<ClipboardCapabilityFactory>(
  "clipboard capability factory",
);
export function provideClipboardCapabilityFactory(
  factory: ClipboardCapabilityFactory,
): DependencyBinding {
  return dependency.provide(factory);
}
export function getClipboardCapabilityFactory(): ClipboardCapabilityFactory {
  return dependency.get();
}
