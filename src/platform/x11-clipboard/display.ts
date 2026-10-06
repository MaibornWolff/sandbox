import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "#platform/clock/index.js";
import type { ProcessManager } from "#platform/process/index.js";
import { deadline, x11Error } from "./operation.js";
import { XConnection } from "./protocol.js";

export async function observeDisplayLifetime(options: {
  process: Promise<void>;
  connection: Promise<void>;
  signal: AbortSignal;
}): Promise<void> {
  const outcome = await Promise.race([
    options.process.then(
      () => "server",
      () => "server",
    ),
    options.connection.then(
      () => "connection",
      () => "connection",
    ),
  ]);
  if (!options.signal.aborted)
    throw new Error(`Private X11 ${outcome} stopped unexpectedly`);
}

function authority(cookie: Buffer): Buffer {
  const fields = [
    Buffer.alloc(0),
    Buffer.alloc(0),
    Buffer.from("MIT-MAGIC-COOKIE-1"),
    cookie,
  ];
  const family = Buffer.from([255, 255]);
  return Buffer.concat([
    family,
    ...fields.flatMap((field) => {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(field.length);
      return [length, field];
    }),
  ]);
}

export async function openDisplay(options: {
  processes: ProcessManager;
  clock: Clock;
  signal: AbortSignal;
}) {
  const resources = new AsyncDisposableStack();
  try {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-x11-"));
    resources.defer(() => rm(directory, { recursive: true, force: true }));
    const authPath = join(directory, "authority");
    const cookie = randomBytes(16);
    await writeFile(authPath, authority(cookie), { mode: 0o600 });
    let output = "";
    let ready: (display: number) => void = () => undefined;
    const displayNumber = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const child = resources.use(
      options.processes.start({
        command: "Xvfb",
        args: [
          "-displayfd",
          "1",
          "-nolisten",
          "tcp",
          "-auth",
          authPath,
          "-screen",
          "0",
          "1x1x24",
          "-noreset",
        ],
        lifetime: "application",
        interaction: { mode: "non-interactive" },
        stdio: "capture",
        signal: options.signal,
        onStdout(chunk) {
          if (output.length > 64) return;
          output += chunk.toString("ascii");
          if (/^\d+\n/.test(output)) ready(Number(output.trim()));
        },
      }),
    );
    const connection = await deadline({
      ...options,
      milliseconds: 5_000,
      run: async (signal) => {
        const display = await Promise.race([
          displayNumber,
          child.result.then(() => {
            throw x11Error(
              "exited",
              "Private X11 server exited before readiness",
            );
          }),
        ]);
        signal.throwIfAborted();
        const client = resources.use(
          await XConnection.connect(display, cookie, signal),
        );
        return { client, display };
      },
    });
    const owned = resources.move();
    return {
      connection: connection.client,
      environment: {
        DISPLAY: `:${connection.display}`,
        XAUTHORITY: authPath,
        WAYLAND_DISPLAY: "",
        XDG_SESSION_TYPE: "x11",
      },
      completion: observeDisplayLifetime({
        process: child.result.then(() => undefined),
        connection: connection.client.completion,
        signal: options.signal,
      }),
      [Symbol.asyncDispose]: () => owned.disposeAsync(),
    };
  } catch (error) {
    await resources.disposeAsync();
    throw error;
  }
}
