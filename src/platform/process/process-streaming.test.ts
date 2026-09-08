import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createSystemClock } from "#platform/clock/index.js";
import { createNodeProcessAdapter } from "./node-process-adapter.js";
import { createProcessManager } from "./process-lifecycle.js";
import type {
  ManagedStreamingProcess,
  ProcessManager,
} from "./process-manager.js";

function environmentVariables(): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function createManager(): ProcessManager {
  return createProcessManager({
    adapter: createNodeProcessAdapter({
      environment: {
        currentWorkingDirectory: process.cwd(),
        variables: environmentVariables(),
      },
      terminal: {
        input: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      },
    }),
    clock: createSystemClock(),
  });
}

function start(
  manager: ProcessManager,
  script: string,
  signal?: AbortSignal,
): ManagedStreamingProcess {
  return manager.start({
    command: process.execPath,
    args: ["-e", script],
    lifetime: "application",
    interaction: { mode: "non-interactive" },
    stdio: "stream",
    ...(signal ? { signal } : {}),
  });
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("streaming process mode", () => {
  test("streams ordered input and separated output through end-of-input", async () => {
    await using manager = createManager();
    const child = start(
      manager,
      `
        const chunks = [];
        process.stdin.on("data", (chunk) => chunks.push(chunk));
        process.stdin.on("end", () => {
          process.stdout.write(Buffer.concat(chunks));
          process.stderr.write("warning");
          process.exitCode = 23;
        });
      `,
    );
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);

    await child.stdin.write(Buffer.from("first "));
    await child.stdin.write(Buffer.from("second"));
    await child.stdin.end();

    await expect(stdout).resolves.toBe("first second");
    await expect(stderr).resolves.toBe("warning");
    await expect(child.result).resolves.toEqual({ exitCode: 23 });
    await expect(child.exited).resolves.toEqual({ exitCode: 23 });
  });

  test("waits for a slow child pipe before settling a large write", async () => {
    await using manager = createManager();
    const child = start(
      manager,
      `
        process.stdin.on("end", () => process.exit(0));
        setTimeout(() => process.stdin.resume(), 250);
      `,
    );
    let settled = false;
    const writing = child.stdin
      .write(new Uint8Array(8 * 1024 * 1024))
      .then(() => {
        settled = true;
      });

    await delay(40);
    expect(settled).toBe(false);

    await writing;
    await child.stdin.end();
    await expect(child.result).resolves.toEqual({ exitCode: 0 });
  });

  test("settles all streams when process startup fails", async () => {
    await using manager = createManager();
    const child = manager.start({
      command: `missing-process-${Date.now()}`,
      lifetime: "application",
      interaction: { mode: "non-interactive" },
      stdio: "stream",
    });
    const operations = Promise.allSettled([
      child.stdout[Symbol.asyncIterator]().next(),
      child.stderr[Symbol.asyncIterator]().next(),
      child.stdin.write(Buffer.from("input")),
    ]);

    await expect(child.result).rejects.toMatchObject({ code: "ENOENT" });
    expect(await operations).toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
    ]);
    await expect(child.exited).resolves.toEqual({});
  });

  test("aborts the child and settles pending stream operations", async () => {
    await using manager = createManager();
    const controller = new AbortController();
    const child = start(
      manager,
      "setInterval(() => undefined, 1_000);",
      controller.signal,
    );
    const operations = Promise.allSettled([
      child.stdout[Symbol.asyncIterator]().next(),
      child.stdin.write(new Uint8Array(8 * 1024 * 1024)),
    ]);
    const reason = new Error("stream cancelled");

    controller.abort(reason);

    await expect(child.result).rejects.toBe(reason);
    const [output, input] = await operations;
    expect(output).toMatchObject({ status: "rejected" });
    expect(input).toEqual({ status: "rejected", reason });
    await expect(child.exited).resolves.toEqual({});
  });

  test("disposal stops the child and settles pending stream operations", async () => {
    await using manager = createManager();
    const child = start(manager, "setInterval(() => undefined, 1_000);");
    const operations = Promise.allSettled([
      child.stdout[Symbol.asyncIterator]().next(),
      child.stdin.write(new Uint8Array(8 * 1024 * 1024)),
    ]);

    await child.dispose();

    const [output, input] = await operations;
    expect(output).toEqual({
      status: "fulfilled",
      value: { done: true, value: undefined },
    });
    expect(input).toMatchObject({ status: "rejected" });
    await expect(child.result).resolves.toEqual({
      exitCode: 143,
      signal: "SIGTERM",
    });
    await expect(child.stdin.write(Buffer.from("late"))).rejects.toBeInstanceOf(
      Error,
    );
  });
});
