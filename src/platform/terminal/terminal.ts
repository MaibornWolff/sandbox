import {
  type Terminal as PiTerminal,
  ProcessTerminal,
} from "@earendil-works/pi-tui";
import {
  createDependency,
  type DependencyBinding,
} from "#platform/dependency-injection/index.js";

export interface TerminalInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): void;
}

/** @lintignore Public terminal contract. */
export interface Terminal extends PiTerminal {
  readonly input: TerminalInput;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly signal: AbortSignal;
  readonly interactive: boolean;
  readonly supportsHyperlinks?: boolean;
}

const terminalDependency = createDependency<Terminal>("terminal");

export function provideTerminal(terminal: Terminal): DependencyBinding {
  return terminalDependency.provide(terminal);
}

export function getTerminal(): Terminal {
  return terminalDependency.get();
}

export interface ProcessTerminalStreams {
  readonly input: TerminalInput;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

export function readProcessTerminalStreams(): ProcessTerminalStreams {
  return {
    input: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

class ApplicationProcessTerminal extends ProcessTerminal implements Terminal {
  readonly input: TerminalInput;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly signal: AbortSignal;
  readonly interactive: boolean;
  readonly supportsHyperlinks: boolean;

  constructor(options: {
    readonly signal: AbortSignal;
    readonly streams: ProcessTerminalStreams;
    readonly supportsHyperlinks: boolean;
  }) {
    super();
    this.input = options.streams.input;
    this.stdout = options.streams.stdout;
    this.stderr = options.streams.stderr;
    this.signal = options.signal;
    this.interactive = options.streams.input.isTTY === true;
    this.supportsHyperlinks = options.supportsHyperlinks;
  }
}

export function createProcessTerminal(options: {
  readonly signal: AbortSignal;
  readonly streams: ProcessTerminalStreams;
}): Terminal {
  return new ApplicationProcessTerminal({
    ...options,
    supportsHyperlinks:
      "isTTY" in options.streams.stdout &&
      options.streams.stdout.isTTY === true &&
      process.env.TERM !== "dumb",
  });
}
