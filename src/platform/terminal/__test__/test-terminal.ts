import { PassThrough, Writable } from "node:stream";
import {
  setImmediate as waitForImmediate,
  setTimeout as waitForTimeout,
} from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { StdinBuffer } from "@earendil-works/pi-tui";
import { Terminal as XtermTerminal } from "@xterm/headless";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  provideTerminal,
  type Terminal,
  type TerminalInput,
} from "../terminal.js";

interface TestTerminalOptions {
  readonly columns?: number;
  readonly rows?: number;
  readonly timeoutMs?: number;
  readonly supportsHyperlinks?: boolean;
}

interface InputModifiers {
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
}

export interface TestTerminalUser {
  inputChunks(...chunks: string[]): Promise<void>;
  type(text: string): Promise<void>;
  enter(count?: number): Promise<void>;
  space(count?: number): Promise<void>;
  escape(count?: number): Promise<void>;
  tab(count?: number): Promise<void>;
  shiftTab(count?: number): Promise<void>;
  backspace(count?: number): Promise<void>;
  up(count?: number): Promise<void>;
  down(count?: number): Promise<void>;
  left(count?: number): Promise<void>;
  right(count?: number): Promise<void>;
  chord(key: string, modifiers: InputModifiers): Promise<void>;
}

export interface TestTerminal {
  readonly io: Terminal;
  readonly user: TestTerminalUser;
  waitForText(text: string): Promise<void>;
  screen(): string;
  output(): string;
  rawOutput(): string;
  stdout(): string;
  stderr(): string;
  rawMode(): boolean;
  run<T>(operation: () => T): T;
  abort(): void;
  dispose(): Promise<void>;
}

class TestTtyInput extends PassThrough implements TerminalInput {
  readonly isTTY = true;
  private raw = false;

  setRawMode(mode: boolean): void {
    this.raw = mode;
  }

  rawMode(): boolean {
    return this.raw;
  }
}

class TerminalOutput extends Writable {
  readonly isTTY = true;
  readonly columns: number;
  readonly rows: number;

  constructor(
    private readonly streamHistory: string[],
    private readonly combinedHistory: string[],
    private readonly terminal: XtermTerminal,
    private readonly notify: () => void,
    dimensions: { readonly columns: number; readonly rows: number },
  ) {
    super();
    this.columns = dimensions.columns;
    this.rows = dimensions.rows;
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = chunk.toString();
    this.streamHistory.push(text);
    this.combinedHistory.push(text);
    this.terminal.write(text, this.notify);
    callback();
  }
}

class TestPiTerminal implements Terminal {
  readonly interactive = true;
  private buffer: StdinBuffer | undefined;
  private dataListener: ((chunk: Buffer | string) => void) | undefined;

  readonly input: TestTtyInput;
  readonly stdout: TerminalOutput;
  readonly stderr: TerminalOutput;
  readonly signal: AbortSignal;
  readonly supportsHyperlinks: boolean;

  constructor(options: {
    readonly input: TestTtyInput;
    readonly stdout: TerminalOutput;
    readonly stderr: TerminalOutput;
    readonly signal: AbortSignal;
    readonly supportsHyperlinks: boolean;
  }) {
    this.input = options.input;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.signal = options.signal;
    this.supportsHyperlinks = options.supportsHyperlinks;
  }

  get columns(): number {
    return this.stdout.columns;
  }

  get rows(): number {
    return this.stdout.rows;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.buffer = new StdinBuffer();
    this.buffer.on("data", onInput);
    this.dataListener = (chunk) => this.buffer?.process(chunk);
    this.input.on("data", this.dataListener);
    this.input.setRawMode(true);
    this.input.resume();
  }

  stop(): void {
    if (this.dataListener) this.input.removeListener("data", this.dataListener);
    this.buffer?.destroy();
    this.buffer = undefined;
    this.dataListener = undefined;
    this.input.pause();
    this.input.setRawMode(false);
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.stdout.write(data);
  }

  moveBy(lines: number): void {
    if (lines > 0) this.write(`\u001b[${lines}B`);
    if (lines < 0) this.write(`\u001b[${-lines}A`);
  }

  hideCursor(): void {
    this.write("\u001b[?25l");
  }

  showCursor(): void {
    this.write("\u001b[?25h");
  }

  clearLine(): void {
    this.write("\u001b[K");
  }

  clearFromCursor(): void {
    this.write("\u001b[J");
  }

  clearScreen(): void {
    this.write("\u001b[2J\u001b[H");
  }

  setTitle(title: string): void {
    this.write(`\u001b]0;${title}\u0007`);
  }

  setProgress(_active: boolean): void {}
}

function repeat(sequence: string, count = 1): string {
  return sequence.repeat(count);
}

function createChord(key: string, modifiers: InputModifiers): string {
  if (key.length !== 1) {
    throw new Error(`Chord key must be one character, received "${key}".`);
  }
  let value = modifiers.shift ? key.toUpperCase() : key;
  if (modifiers.ctrl) {
    value = String.fromCharCode(value.toUpperCase().charCodeAt(0) & 31);
  }
  return modifiers.alt ? `\u001b${value}` : value;
}

export function createTestTerminal(
  options: TestTerminalOptions = {},
): TestTerminal {
  const terminal = new XtermTerminal({
    cols: options.columns ?? 80,
    rows: options.rows ?? 24,
    allowProposedApi: true,
  });
  const input = new TestTtyInput();
  const controller = new AbortController();
  const history: string[] = [];
  const stdoutHistory: string[] = [];
  const stderrHistory: string[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const dimensions = {
    columns: options.columns ?? 80,
    rows: options.rows ?? 24,
  };
  const stdout = new TerminalOutput(
    stdoutHistory,
    history,
    terminal,
    notify,
    dimensions,
  );
  const stderr = new TerminalOutput(
    stderrHistory,
    history,
    terminal,
    notify,
    dimensions,
  );
  const timeoutMs = options.timeoutMs ?? 2_000;
  const terminalIo = new TestPiTerminal({
    input,
    stdout,
    stderr,
    signal: controller.signal,
    supportsHyperlinks: options.supportsHyperlinks ?? false,
  });

  function screen(): string {
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < terminal.rows; index++) {
      const line = buffer.getLine(buffer.viewportY + index);
      const text = line?.translateToString(true) ?? "";
      if (line?.isWrapped && lines.length > 0) {
        lines[lines.length - 1] += text;
      } else {
        lines.push(text);
      }
    }
    return lines.join("\n").trimEnd();
  }

  function rawOutput(): string {
    return history.join("");
  }

  function output(): string {
    return stripVTControlCharacters(rawOutput());
  }

  async function send(sequence: string): Promise<void> {
    input.write(sequence);
    await waitForImmediate();
  }

  const user: TestTerminalUser = {
    async inputChunks(...chunks) {
      for (const chunk of chunks) {
        input.write(chunk);
        await waitForImmediate();
      }
    },
    type: send,
    enter: (count) => send(repeat("\r", count)),
    space: (count) => send(repeat(" ", count)),
    async escape(count) {
      await send(repeat("\u001b", count));
      await waitForTimeout(25);
    },
    tab: (count) => send(repeat("\t", count)),
    shiftTab: (count) => send(repeat("\u001b[Z", count)),
    backspace: (count) => send(repeat("\u007f", count)),
    up: (count) => send(repeat("\u001b[A", count)),
    down: (count) => send(repeat("\u001b[B", count)),
    left: (count) => send(repeat("\u001b[D", count)),
    right: (count) => send(repeat("\u001b[C", count)),
    chord: (key, modifiers) => send(createChord(key, modifiers)),
  };

  return {
    io: terminalIo,
    user,
    waitForText(text) {
      if (screen().includes(text)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const check = () => {
          if (!screen().includes(text)) return;
          clearTimeout(timeout);
          clearInterval(interval);
          listeners.delete(check);
          resolve();
        };
        const interval = setInterval(check, 10);
        const timeout = setTimeout(() => {
          clearInterval(interval);
          listeners.delete(check);
          reject(
            new Error(
              `Timed out waiting for terminal text "${text}".\nCurrent screen:\n${screen()}\n\nRecent output:\n${output().slice(-2_000)}`,
            ),
          );
        }, timeoutMs);
        listeners.add(check);
      });
    },
    screen,
    output,
    rawOutput,
    stdout: () => stripVTControlCharacters(stdoutHistory.join("")),
    stderr: () => stripVTControlCharacters(stderrHistory.join("")),
    run: (operation) =>
      runWithDependencies([provideTerminal(terminalIo)], operation),
    rawMode: () => input.rawMode(),
    abort() {
      controller.abort();
      input.setRawMode(false);
    },
    async dispose() {
      controller.abort();
      input.setRawMode(false);
      input.destroy();
      stdout.destroy();
      stderr.destroy();
      listeners.clear();
      terminal.dispose();
      await waitForImmediate();
    },
  };
}
