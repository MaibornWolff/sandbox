import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { installTerminalOutputProtection } from "./index.js";

function outputError(code: string): Error {
  return Object.assign(new Error(`write ${code}`), { code });
}

function terminalStreams() {
  return {
    input: new PassThrough(),
    stdout: new PassThrough(),
    stderr: Object.assign(new PassThrough(), { isTTY: true }),
  };
}

describe("terminal output protection", () => {
  test.each([
    ["stdout", "stderr", "EPIPE"],
    ["stderr", "stdout", "EIO"],
  ] as const)(
    "stops writing to %s without affecting %s",
    async (failed, healthy, code) => {
      const streams = terminalStreams();
      installTerminalOutputProtection(streams);
      const output: string[] = [];
      streams[failed].on("data", (chunk: Buffer) =>
        output.push(chunk.toString()),
      );
      streams[healthy].on("data", (chunk: Buffer) =>
        output.push(chunk.toString()),
      );

      streams[failed].write("before disconnect");
      await new Promise<void>((resolve) =>
        setImmediate(() => {
          streams[failed].emit("error", outputError(code));
          resolve();
        }),
      );
      streams[failed].write("after disconnect");
      streams[healthy].write(Buffer.from("healthy output"));

      expect(output).toEqual(["before disconnect", "healthy output"]);
    },
  );

  test("installs a single listener on shared output streams", () => {
    const { input, stdout } = terminalStreams();
    const streams = { input, stdout, stderr: stdout };
    installTerminalOutputProtection(streams);
    installTerminalOutputProtection(streams);

    expect(stdout.listenerCount("error")).toBe(1);
  });

  test.each([
    ["stdout", "EIO"],
    ["stderr", "ENOSPC"],
  ] as const)("surfaces %s errors with code %s", (destination, code) => {
    const streams = terminalStreams();
    installTerminalOutputProtection(streams);
    const error = outputError(code);

    expect(() => streams[destination].emit("error", error)).toThrow(error);
  });

  test("discards output after a synchronous disconnect and completes write callbacks", async () => {
    const streams = terminalStreams();
    let attempts = 0;
    streams.stderr.write = () => {
      attempts += 1;
      throw outputError("EIO");
    };
    installTerminalOutputProtection(streams);

    await new Promise<void>((resolve, reject) => {
      streams.stderr.write("first", (error) =>
        error ? reject(error) : resolve(),
      );
    });
    streams.stderr.write("second");

    expect(attempts).toBe(1);
  });
});
