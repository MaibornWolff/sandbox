import { mapNativeFormats } from "./formats.js";
import {
  type NativeClipboardBackend,
  NativeClipboardError,
  type NativeClipboardFormat,
  type NativeClipboardItem,
  type NativeClipboardOptions,
  type NativeClipboardService,
} from "./types.js";

const MAX_PENDING_CALLS = 8;

function cancelled(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new NativeClipboardError("cancelled")),
      { once: true },
    );
  });
}

/**
 * Runs native clipboard calls in the current process, one at a time.
 * Cancellation stops the wait but cannot stop a native call that already
 * started, so later calls wait for it.
 */
class InProcessNativeClipboard implements NativeClipboardService {
  private backend: Promise<NativeClipboardBackend> | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private readonly disposal = new AbortController();

  constructor(
    private readonly platform: NodeJS.Platform,
    private readonly loadBackend: () => Promise<NativeClipboardBackend>,
  ) {}

  discover(
    options?: NativeClipboardOptions,
  ): Promise<readonly NativeClipboardFormat[]> {
    return this.run(options, (native) => this.formats(native));
  }

  read(
    format: NativeClipboardFormat,
    options?: NativeClipboardOptions,
  ): Promise<Buffer> {
    return this.run(options, async (native) => {
      if (!(await this.formats(native)).includes(format)) {
        throw new NativeClipboardError("missing-format");
      }
      if (format === "text/plain") {
        return Buffer.from(await native.getText(), "utf8");
      }
      return Buffer.from(await native.getImageBase64(), "base64");
    });
  }

  async publish(
    item: NativeClipboardItem,
    options?: NativeClipboardOptions,
  ): Promise<void> {
    const data = Buffer.from(item.data);
    let started = false;
    try {
      await this.run(options, async (native) => {
        started = true;
        if (item.format === "text/plain") {
          await native.setText(data.toString("utf8"));
        } else {
          await native.setImageBase64(data.toString("base64"));
        }
      });
    } catch (error) {
      if (started) {
        throw new NativeClipboardError("publication-uncertain");
      }
      throw error;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposal.abort();
  }

  private async formats(
    native: NativeClipboardBackend,
  ): Promise<NativeClipboardFormat[]> {
    return mapNativeFormats(this.platform, await native.availableFormats());
  }

  private load(): Promise<NativeClipboardBackend> {
    this.backend ??= this.loadBackend().catch(() => {
      throw new NativeClipboardError("backend-unavailable");
    });
    return this.backend;
  }

  private async run<T>(
    options: NativeClipboardOptions | undefined,
    action: (native: NativeClipboardBackend) => Promise<T>,
  ): Promise<T> {
    if (this.disposal.signal.aborted)
      throw new NativeClipboardError("disposed");
    if (this.pending >= MAX_PENDING_CALLS)
      throw new NativeClipboardError("busy");
    const signal = AbortSignal.any(
      [options?.signal, this.disposal.signal].filter(
        (item) => item !== undefined,
      ),
    );
    if (signal.aborted) throw new NativeClipboardError("cancelled");

    this.pending++;
    const call = this.tail.then(async () => {
      if (signal.aborted) throw new NativeClipboardError("cancelled");
      return await action(await this.load());
    });
    this.tail = call.then(
      () => this.pending--,
      () => this.pending--,
    );
    try {
      return await Promise.race([call, cancelled(signal)]);
    } catch (error) {
      if (error instanceof NativeClipboardError) throw error;
      throw new NativeClipboardError("backend-failure");
    }
  }
}

function loadCrosscopyBackend(): Promise<NativeClipboardBackend> {
  return import("@crosscopy/clipboard");
}

export function createNativeClipboardService(
  platform: NodeJS.Platform,
  loadBackend: () => Promise<NativeClipboardBackend>,
): NativeClipboardService {
  return new InProcessNativeClipboard(platform, loadBackend);
}

export function createCrosscopyClipboardService(
  platform: NodeJS.Platform,
): NativeClipboardService {
  return createNativeClipboardService(platform, loadCrosscopyBackend);
}
