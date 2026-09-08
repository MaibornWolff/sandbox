import { StringDecoder } from "node:string_decoder";
import chalk from "chalk";
import { getLogger } from "#platform/logging/index.js";
import {
  getProcessManager,
  type ManagedProcess,
  type ProcessResult,
  ProcessShutdownError,
} from "#platform/process/index.js";
import type { ContainerRuntime } from "./types.js";

interface ContainerLogStream {
  reportFailure(): void;
  stop(): Promise<void>;
}

interface LineForwarder {
  write(chunk: Buffer): void;
  close(): void;
}

const MAX_FORWARDED_LINE_LENGTH = 16_384;
const LOG_TAIL_LINES = 200;
const STOP_TIMEOUT_MILLISECONDS = 1_000;

function createLineForwarder(writeLine: (line: string) => void): LineForwarder {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let closed = false;

  function boundedPrefixLength(value: string): number {
    const lastCodeUnit = value.charCodeAt(MAX_FORWARDED_LINE_LENGTH - 1);
    const splitsSurrogatePair =
      lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff;
    return splitsSurrogatePair
      ? MAX_FORWARDED_LINE_LENGTH - 1
      : MAX_FORWARDED_LINE_LENGTH;
  }

  function writeBounded(line: string): void {
    let remaining = line;
    while (remaining.length > MAX_FORWARDED_LINE_LENGTH) {
      const prefixLength = boundedPrefixLength(remaining);
      writeLine(remaining.slice(0, prefixLength));
      remaining = remaining.slice(prefixLength);
    }
    writeLine(remaining.replace(/\r$/, ""));
  }

  function writeDecoded(chunk: string): void {
    const lines = `${pending}${chunk}`.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) writeBounded(line);
    while (pending.length >= MAX_FORWARDED_LINE_LENGTH) {
      const prefixLength = boundedPrefixLength(pending);
      writeLine(pending.slice(0, prefixLength));
      pending = pending.slice(prefixLength);
    }
  }

  return {
    write(chunk) {
      if (!closed) writeDecoded(decoder.write(chunk));
    },
    close() {
      if (closed) return;
      closed = true;
      writeDecoded(decoder.end());
      if (pending) writeBounded(pending);
      pending = "";
    },
  };
}

export function startContainerLogStream(
  runtime: Pick<ContainerRuntime, "binaryName">,
  containerName: string,
): ContainerLogStream {
  const logger = getLogger();
  const capturedLines: string[] = [];
  function captureLine(line: string): void {
    capturedLines.push(line);
    if (capturedLines.length > LOG_TAIL_LINES) capturedLines.shift();
    logger.debug(line);
  }
  const stdout = createLineForwarder(captureLine);
  const stderr = createLineForwarder(captureLine);
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let child: ManagedProcess<ProcessResult>;
  try {
    child = getProcessManager().start({
      command: runtime.binaryName,
      args: [
        "logs",
        "--follow",
        "--tail",
        String(LOG_TAIL_LINES),
        containerName,
      ],
      lifetime: "application",
      interaction: { mode: "non-interactive" },
      stdio: "ignore",
      stdin: "ignore",
      onStdout: (chunk) => stdout.write(chunk),
      onStderr: (chunk) => stderr.write(chunk),
      name: "container log stream",
    });
  } catch (error) {
    logger.warn(
      `Container log stream for ${chalk.cyan(containerName)} failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      reportFailure: () => undefined,
      stop: async () => undefined,
    };
  }
  void child.result
    .then((result) => {
      stdout.close();
      stderr.close();
      if (!stopping) {
        logger.warn(
          `Container log stream for ${chalk.cyan(containerName)} stopped with exit code ${result.exitCode}`,
        );
      }
    })
    .catch((error: unknown) => {
      stdout.close();
      stderr.close();
      if (!stopping) {
        logger.warn(
          `Container log stream for ${chalk.cyan(containerName)} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

  return {
    reportFailure() {
      logger.error(
        capturedLines.length > 0
          ? `Container startup logs for ${chalk.cyan(containerName)}:\n${capturedLines.join("\n")}`
          : `Container startup for ${chalk.cyan(containerName)} produced no captured logs`,
      );
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      stopPromise = child
        .stop({
          gracefulTimeoutMilliseconds: STOP_TIMEOUT_MILLISECONDS,
          forceTimeoutMilliseconds: STOP_TIMEOUT_MILLISECONDS,
        })
        .then(() => undefined)
        .catch((error: unknown) => {
          if (!(error instanceof ProcessShutdownError)) throw error;
          logger.warn(
            `Container log stream for ${chalk.cyan(containerName)} did not exit after SIGKILL`,
          );
        })
        .finally(() => {
          stdout.close();
          stderr.close();
        });
      return stopPromise;
    },
  };
}
