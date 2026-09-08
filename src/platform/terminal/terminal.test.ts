import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import * as terminalModule from "./index.js";
import {
  createProcessTerminal,
  getTerminal,
  provideTerminal,
} from "./index.js";

describe("process terminal", () => {
  test("binds process streams and an application abort signal", () => {
    const moduleExports = terminalModule as Record<string, unknown>;
    const createProcessTerminal = moduleExports.createProcessTerminal;
    const readProcessTerminalStreams = moduleExports.readProcessTerminalStreams;

    expect(typeof createProcessTerminal).toBe("function");
    expect(typeof readProcessTerminalStreams).toBe("function");

    const streams = (
      readProcessTerminalStreams as () => {
        input: NodeJS.ReadableStream;
        stdout: NodeJS.WritableStream;
        stderr: NodeJS.WritableStream;
      }
    )();
    const controller = new AbortController();
    const io = (
      createProcessTerminal as (options: {
        signal: AbortSignal;
        streams: typeof streams;
      }) => {
        input: NodeJS.ReadableStream;
        stdout: NodeJS.WritableStream;
        stderr: NodeJS.WritableStream;
        signal: AbortSignal;
        interactive: boolean;
      }
    )({ signal: controller.signal, streams });

    expect(io.input).toBe(process.stdin);
    expect(io.stdout).toBe(process.stdout);
    expect(io.stderr).toBe(process.stderr);
    expect(io.signal).toBe(controller.signal);
    expect(io.interactive).toBe(process.stdin.isTTY === true);
  });

  test("resolves only the terminal bound to the active scope", () => {
    const controller = new AbortController();
    const terminal = createProcessTerminal({
      signal: controller.signal,
      streams: {
        input: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      },
    });

    expect(
      runWithDependencies([provideTerminal(terminal)], () => getTerminal()),
    ).toBe(terminal);
    expect(() => getTerminal()).toThrow(
      'Dependency "terminal" is not registered in the active scope.',
    );
  });
});
