import type { ChildProcess } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import spawnChild from "cross-spawn";
import { getExitCodeForSignal } from "./exit-code.js";
import type {
  ProcessAdapter,
  ProcessIdentity,
  ProcessIdentityStatus,
  StartedProcess,
  StartedStreamingProcess,
} from "./process-adapter.js";
import type {
  ProcessInput,
  ProcessResult,
  StandardProcessRequest,
  StartProcessRequest,
  StreamingProcessRequest,
  StreamingProcessResult,
} from "./process-manager.js";

interface ProcessEnvironment {
  readonly currentWorkingDirectory: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
}

interface ProcessTerminal {
  readonly input: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly signal?: AbortSignal;
  readonly interactive?: boolean;
}

function abortError(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}

function getStreamDescriptor(
  stream: NodeJS.ReadableStream | NodeJS.WritableStream,
): number | undefined {
  if (!("fd" in stream) || typeof stream.fd !== "number") return undefined;
  return stream.fd;
}

function getChildStdio(
  request: StartProcessRequest,
  stdio: "capture" | "inherit" | "ignore" | "stream",
  terminal: ProcessTerminal,
): [
  "ignore" | "pipe" | number,
  "ignore" | "pipe" | number,
  "ignore" | "pipe" | number,
] {
  if (stdio === "stream") return ["pipe", "pipe", "pipe"];
  if (
    stdio === "ignore" &&
    !request.stdoutFile &&
    !request.onStdout &&
    !request.onStderr
  ) {
    return ["ignore", "ignore", "ignore"];
  }
  if (
    stdio !== "inherit" ||
    request.stdoutFile ||
    request.onStdout ||
    request.onStderr
  ) {
    return [
      stdio === "inherit" && request.stdin !== "ignore" ? "pipe" : "ignore",
      "pipe",
      "pipe",
    ];
  }
  const descriptors = [
    request.stdin === "ignore" ? "ignore" : getStreamDescriptor(terminal.input),
    getStreamDescriptor(terminal.stdout),
    getStreamDescriptor(terminal.stderr),
  ];
  if (
    descriptors[0] === "ignore" &&
    descriptors.slice(1).every((value) => value !== undefined)
  ) {
    return descriptors as ["ignore", number, number];
  }
  if (descriptors.every((value) => typeof value === "number")) {
    return descriptors as [number, number, number];
  }
  return [request.stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe"];
}

function attachOutput(options: {
  readonly child: ChildProcess;
  readonly request: StandardProcessRequest;
  readonly stdio: "capture" | "inherit" | "ignore";
  readonly terminal: ProcessTerminal;
  readonly outputFile?: NodeJS.WritableStream;
}): { stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  options.child.stdout?.on("data", (chunk: Buffer) => {
    if (options.stdio === "capture") stdout += chunk.toString();
    if (options.stdio === "inherit") options.terminal.stdout.write(chunk);
    options.request.onStdout?.(chunk);
    options.outputFile?.write(chunk);
  });
  options.child.stderr?.on("data", (chunk: Buffer) => {
    if (options.stdio === "capture") stderr += chunk.toString();
    if (options.stdio === "inherit") options.terminal.stderr.write(chunk);
    options.request.onStderr?.(chunk);
  });
  return { stdout: () => stdout, stderr: () => stderr };
}

function createResult(options: {
  readonly child: ChildProcess;
  readonly request: StandardProcessRequest;
  readonly stdio: "capture" | "inherit" | "ignore";
  readonly terminal: ProcessTerminal;
  readonly outputFile?: NodeJS.WritableStream;
  readonly output: { stdout: () => string; stderr: () => string };
  readonly wasAborted: () => boolean;
  readonly onAbort: () => void;
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    options.child.once("error", reject);
    options.child.once("close", (exitCode, signal) => {
      options.request.signal?.removeEventListener("abort", options.onAbort);
      if (options.stdio === "inherit" && options.child.stdin) {
        options.terminal.input.unpipe(options.child.stdin);
      }
      options.outputFile?.end();
      if (options.wasAborted() && options.request.signal) {
        reject(abortError(options.request.signal));
        return;
      }
      resolve({
        exitCode: exitCode ?? (signal ? getExitCodeForSignal(signal) : 0),
        ...(signal ? { signal } : {}),
        stdout: options.output.stdout(),
        stderr: options.output.stderr(),
      });
    });
  });
}

function probePid(pid: number): ProcessIdentityStatus {
  try {
    process.kill(pid, 0);
    return "running";
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "ESRCH") return "missing";
    if (code === "EPERM") return "running";
    throw error instanceof Error
      ? error
      : new Error("Unexpected error while checking process liveness", {
          cause: error,
        });
  }
}

function linuxStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19];
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw error;
  }
}

function cancelledProcess(signal: AbortSignal): StartedProcess {
  return {
    result: Promise.reject(abortError(signal)),
    exited: Promise.resolve(),
  };
}

function rejectedInput(error: unknown): ProcessInput {
  return {
    write: () => Promise.reject(error),
    end: () => Promise.reject(error),
  };
}

function rejectedOutput(error: unknown): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => Promise.reject(error) };
    },
  };
}

function cancelledStreamingProcess(
  signal: AbortSignal,
): StartedStreamingProcess {
  const error = abortError(signal);
  return {
    result: Promise.reject(error),
    exited: Promise.resolve(),
    stdin: rejectedInput(error),
    stdout: rejectedOutput(error),
    stderr: rejectedOutput(error),
  };
}

function childStreams(child: ChildProcess): {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
} {
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill("SIGTERM");
    throw new Error("Streaming child process pipes are unavailable.");
  }
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
  };
}

function streamFailure(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Child process stream failed.", { cause: error });
}

function streamBytes(
  stream: Readable,
  fail: (error: unknown) => void,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of stream) {
          yield typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        }
      } catch (error) {
        fail(error);
        throw error;
      }
    },
  };
}

function startStreamingProcess(
  options: {
    readonly environment: ProcessEnvironment;
    readonly terminal: ProcessTerminal;
  },
  request: StreamingProcessRequest,
): StartedStreamingProcess {
  if (request.signal?.aborted) return cancelledStreamingProcess(request.signal);
  const child = spawnChild(request.command, [...(request.args ?? [])], {
    cwd: request.cwd ?? options.environment.currentWorkingDirectory,
    env: { ...options.environment.variables, ...request.env },
    detached: false,
    stdio: getChildStdio(request, "stream", options.terminal),
    windowsHide: true,
  });
  const streams = childStreams(child);
  let failed: unknown;
  let inputFailure: unknown;
  let inputEnded = false;
  const pendingInput = new Set<(error: unknown) => void>();
  let rejectResult: (error: unknown) => void = () => undefined;

  const failInput = (error: unknown) => {
    if (inputFailure !== undefined) return;
    inputFailure = error;
    for (const reject of pendingInput) reject(error);
    pendingInput.clear();
  };
  const fail = (error: unknown) => {
    if (failed !== undefined) return;
    failed = error;
    failInput(error);
    rejectResult(error);
    const failure = streamFailure(error);
    if (!streams.stdin.destroyed) streams.stdin.destroy(failure);
    if (!streams.stdout.destroyed) streams.stdout.destroy(failure);
    if (!streams.stderr.destroyed) streams.stderr.destroy(failure);
    child.kill("SIGTERM");
  };
  streams.stdin.once("error", failInput);
  streams.stdout.once("error", fail);
  streams.stderr.once("error", fail);
  child.once("error", fail);

  const stdin: ProcessInput = {
    write(chunk) {
      if (failed !== undefined) return Promise.reject(failed);
      if (inputFailure !== undefined) return Promise.reject(inputFailure);
      if (inputEnded) {
        return Promise.reject(new Error("Child process input has ended."));
      }
      return new Promise<void>((resolve, reject) => {
        const rejectOperation = (error: unknown) => reject(error);
        pendingInput.add(rejectOperation);
        streams.stdin.write(chunk, (error) => {
          pendingInput.delete(rejectOperation);
          if (error) {
            failInput(error);
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    end() {
      if (failed !== undefined) return Promise.reject(failed);
      if (inputFailure !== undefined) return Promise.reject(inputFailure);
      if (inputEnded) return Promise.resolve();
      inputEnded = true;
      return new Promise<void>((resolve, reject) => {
        const rejectOperation = (error: unknown) => reject(error);
        pendingInput.add(rejectOperation);
        streams.stdin.end(() => {
          pendingInput.delete(rejectOperation);
          resolve();
        });
      });
    },
  };
  const result = new Promise<StreamingProcessResult>((resolve, reject) => {
    rejectResult = reject;
    child.once("close", (exitCode, signal) => {
      request.signal?.removeEventListener("abort", onAbort);
      if (failed !== undefined) {
        reject(failed);
        return;
      }
      resolve({
        exitCode: exitCode ?? (signal ? getExitCodeForSignal(signal) : 0),
        ...(signal ? { signal } : {}),
      });
    });
  });
  const onAbort = () => {
    if (request.signal) fail(abortError(request.signal));
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const exited = new Promise<void>((resolve) =>
    child.once("close", () => {
      failInput(new Error("Child process input closed."));
      resolve();
    }),
  );
  const identity =
    child.pid === undefined ? undefined : { pid: child.pid, token: child };
  return {
    ...(identity ? { identity } : {}),
    result,
    exited,
    stdin,
    stdout: streamBytes(streams.stdout, fail),
    stderr: streamBytes(streams.stderr, fail),
  };
}

function startStandardProcess(
  options: {
    readonly environment: ProcessEnvironment;
    readonly terminal: ProcessTerminal;
  },
  request: StandardProcessRequest,
): StartedProcess {
  if (request.signal?.aborted) return cancelledProcess(request.signal);
  const stdio =
    request.interaction.mode === "interactive"
      ? "inherit"
      : (request.stdio ?? "capture");
  const child = spawnChild(request.command, [...(request.args ?? [])], {
    cwd: request.cwd ?? options.environment.currentWorkingDirectory,
    env: { ...options.environment.variables, ...request.env },
    detached: request.lifetime === "detached",
    stdio: getChildStdio(request, stdio, options.terminal),
    windowsHide: true,
  });
  const outputFile = request.stdoutFile
    ? createWriteStream(request.stdoutFile.path, {
        flags: request.stdoutFile.append ? "a" : "w",
      })
    : undefined;
  if (stdio === "inherit" && request.stdin !== "ignore" && child.stdin) {
    options.terminal.input.pipe(child.stdin);
  }
  const output = attachOutput({
    child,
    request,
    stdio,
    terminal: options.terminal,
    ...(outputFile ? { outputFile } : {}),
  });
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    child.kill("SIGTERM");
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const result = createResult({
    child,
    request,
    stdio,
    terminal: options.terminal,
    ...(outputFile ? { outputFile } : {}),
    output,
    wasAborted: () => aborted,
    onAbort,
  });
  const exited = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  const identity =
    child.pid === undefined ? undefined : { pid: child.pid, token: child };
  return {
    ...(identity ? { identity } : {}),
    result,
    exited,
  };
}

export function createNodeProcessAdapter(options: {
  readonly environment: ProcessEnvironment;
  readonly terminal: ProcessTerminal;
}): ProcessAdapter {
  const platform = options.environment.platform ?? process.platform;
  function start(request: StreamingProcessRequest): StartedStreamingProcess;
  function start(request: StandardProcessRequest): StartedProcess;
  function start(
    request: StartProcessRequest,
  ): StartedProcess | StartedStreamingProcess {
    return request.stdio === "stream"
      ? startStreamingProcess(options, request)
      : startStandardProcess(options, request);
  }
  return {
    start,
    capture(pid) {
      if (platform !== "linux") {
        return {
          status: "unsupported",
          reason: `Stable external process identity is unsupported on ${platform}.`,
        };
      }
      const token = linuxStartTime(pid);
      return token === undefined
        ? { status: "missing" }
        : { status: "captured", identity: { pid, token } };
    },
    identityStatus(identity) {
      const status = probePid(identity.pid);
      if (status !== "running" || typeof identity.token !== "string")
        return status;
      const current = linuxStartTime(identity.pid);
      if (current === undefined) return "missing";
      return current === identity.token ? "running" : "changed";
    },
    signal(identity: ProcessIdentity, signal) {
      if (identity.token instanceof Object && "kill" in identity.token) {
        (identity.token as ChildProcess).kill(signal);
        return;
      }
      process.kill(identity.pid, signal);
    },
    unref(identity) {
      if (identity.token instanceof Object && "unref" in identity.token) {
        (identity.token as ChildProcess).unref();
      }
    },
    subscribeToSignals(signals, listener) {
      const registrations = signals.map((signal) => {
        const handler = () => listener(signal);
        process.on(signal, handler);
        return { signal, handler };
      });
      return () => {
        for (const { signal, handler } of registrations)
          process.off(signal, handler);
      };
    },
    setTitle(title) {
      const previous = process.title;
      process.title = title;
      return () => {
        process.title = previous;
      };
    },
  };
}
