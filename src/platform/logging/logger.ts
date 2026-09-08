import chalk from "chalk";
import type { Clock } from "#platform/clock/index.js";
import {
  createDependency,
  type DependencyBinding,
} from "#platform/dependency-injection/index.js";

interface TimingMarker {
  label: string;
  startTime: number;
}

interface LoggerSettings {
  readonly verbose?: boolean;
  readonly silent?: boolean;
  readonly showElapsedTime?: boolean;
}

/** @lintignore Public logger contract. */
export interface Logger {
  success(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
  startTiming(label: string): void;
  endTiming(label: string): void;
  setVerbose(verbose: boolean): void;
  setSilent(silent: boolean): void;
}

const loggerDependency = createDependency<Logger>("logger");

export function provideLogger(scopedLogger: Logger): DependencyBinding {
  return loggerDependency.provide(scopedLogger);
}

export function getLogger(): Logger {
  return loggerDependency.get();
}

interface DiagnosticChild {
  readonly label: string;
  readonly value: unknown;
}

function diagnosticChildren(error: Error): readonly DiagnosticChild[] {
  const children: DiagnosticChild[] = [];
  if (error.cause !== undefined) {
    children.push({ label: "Caused by", value: error.cause });
  }
  if (error instanceof AggregateError) {
    children.push(
      ...error.errors.map((value) => ({ label: "Aggregated error", value })),
    );
  }
  const suppressed = (
    error as Error & { readonly suppressedErrors?: readonly unknown[] }
  ).suppressedErrors;
  children.push(
    ...(suppressed ?? []).map((value) => ({
      label: "Suppressed error",
      value,
    })),
  );
  return children;
}

export function formatErrorDiagnostics(error: unknown): string {
  const seen = new Set<unknown>();
  const lines: string[] = [];
  function append(value: unknown, label?: string): void {
    if (seen.has(value)) return;
    if (typeof value === "object" && value !== null) seen.add(value);
    const rendered =
      value instanceof Error ? (value.stack ?? value.message) : String(value);
    lines.push(label ? `${label}: ${rendered}` : rendered);
    if (!(value instanceof Error)) return;
    for (const child of diagnosticChildren(value)) {
      append(child.value, child.label);
    }
  }
  append(error);
  return lines.join("\n");
}

class LoggerInstance implements Logger {
  private verbose: boolean;
  private silent: boolean;
  private timings: Map<string, TimingMarker> = new Map();
  private globalStartTime: number;
  private readonly showElapsedTime: boolean;
  private readonly stderr: (message: string) => void;
  private readonly clock: Clock;

  constructor(
    clock: Clock,
    stderr: (message: string) => void,
    settings: LoggerSettings,
  ) {
    this.stderr = stderr;
    this.clock = clock;
    this.verbose = settings.verbose ?? false;
    this.silent = settings.silent ?? false;
    this.showElapsedTime = settings.showElapsedTime ?? true;
    this.globalStartTime = clock.now();
  }

  // Log level methods
  success(message: string): void {
    if (this.silent) return;
    this.stderr(`${chalk.green("✓")} ${message}`);
  }

  info(message: string): void {
    if (this.silent) return;
    this.stderr(`${chalk.blue("→")} ${message}`);
  }

  warn(message: string): void {
    if (this.silent) return;
    this.stderr(`${chalk.yellow("⚠")} ${message}`);
  }

  error(message: string): void {
    this.stderr(`${chalk.red("✗")} ${message}`);
  }

  // Verbose-only methods
  debug(message: string): void {
    if (this.silent || !this.verbose) return;
    if (!this.showElapsedTime) {
      this.stderr(chalk.gray(message));
      return;
    }
    const elapsed = this.clock.now() - this.globalStartTime;
    this.stderr(chalk.gray(`[+${elapsed}ms] ${message}`));
  }

  startTiming(label: string): void {
    if (this.silent || !this.verbose) return;
    this.timings.set(label, {
      label,
      startTime: this.clock.now(),
    });
  }

  endTiming(label: string): void {
    if (this.silent || !this.verbose) return;
    const timing = this.timings.get(label);
    if (!timing) {
      this.warn(`No timing found for: ${label}`);
      return;
    }

    const duration = this.clock.now() - timing.startTime;
    const elapsed = this.clock.now() - this.globalStartTime;
    this.stderr(
      chalk.gray(`[+${elapsed}ms] ${label} completed in ${duration}ms`),
    );
    this.timings.delete(label);
  }

  setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  setSilent(silent: boolean): void {
    this.silent = silent;
  }
}

export function createLineWriter(
  stream: Pick<NodeJS.WritableStream, "write">,
  prefix = "",
): (message: string) => void {
  return (message) => {
    stream.write(`${prefix}${message}\n`);
  };
}

export function createLogger(
  clock: Clock,
  stderr: (message: string) => void,
  settings: LoggerSettings = {},
): Logger {
  return new LoggerInstance(clock, stderr, settings);
}
