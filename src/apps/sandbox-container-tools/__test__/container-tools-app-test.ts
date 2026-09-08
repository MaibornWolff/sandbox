import * as fs from "node:fs";
import * as path from "node:path";
import {
  createTestClock,
  type TestClock,
} from "#platform/clock/__test__/index.js";
import { provideClock } from "#platform/clock/index.js";
import {
  createStatefulTcpService,
  type StatefulTcpService,
} from "#platform/container-system/__test__/index.js";
import {
  provideTcpService,
  type TcpEndpoint,
} from "#platform/container-system/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createTestSandboxEnvironment } from "#platform/environment/__test__/index.js";
import type { SandboxEnvironment } from "#platform/environment/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import {
  createProcessTestHarness,
  type ProcessTestAction,
  type ProcessTestHarness,
  type TestProcess,
} from "#platform/process/__test__/index.js";
import type { ProcessResult } from "#platform/process/index.js";
import { provideProcessManager } from "#platform/process/index.js";
import {
  createTestTerminal,
  type TestTerminal,
} from "#platform/terminal/__test__/index.js";
import { provideTerminal } from "#platform/terminal/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { runContainerToolsApplication } from "../application.js";

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ContainerToolsAppTestOptions {
  readonly version?: string;
  readonly variables?: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
}

interface ChildOptions {
  readonly ready?: boolean;
  readonly messages?: readonly string[];
}

export interface ContainerToolsChild {
  readonly pid: number | undefined;
  readonly name: string | undefined;
  readonly signals: readonly NodeJS.Signals[];
  readonly messages: readonly string[];
  isReady(): boolean;
  markReady(): void;
  waitForSignal(): Promise<NodeJS.Signals>;
  exit(options?: {
    readonly exitCode?: number;
    readonly signal?: NodeJS.Signals;
    readonly stderr?: string;
  }): void;
}

export interface ContainerToolsAppTest {
  readonly cli: {
    run(...args: string[]): Promise<CliResult>;
  };
  readonly entrypoint: {
    start(...defaultCommand: string[]): Promise<CliResult>;
    isReady(): boolean;
    waitForReady(): Promise<void>;
  };
  readonly roots: {
    readonly temporary: string;
    readonly container: string;
    readonly home: string;
  };
  readonly environment: SandboxEnvironment;
  readonly output: {
    stdout(): string;
    stderr(): string;
  };
  readonly files: {
    write(absolutePath: string, content: string): void;
    read(absolutePath: string): string;
    exists(absolutePath: string): boolean;
  };
  readonly children: {
    givenRequired(name: string, options?: ChildOptions): ContainerToolsChild;
    givenOptional(name: string, options?: ChildOptions): ContainerToolsChild;
    waitForSpawn(name?: string): Promise<void>;
    events(): readonly ProcessTestAction[];
    pending(): number;
  };
  readonly signals: {
    send(signal: "SIGTERM" | "SIGINT"): void;
    subscriptions(): number;
  };
  readonly sockets: {
    listen(endpoint: TcpEndpoint): void;
    close(endpoint: TcpEndpoint): void;
    fail(endpoint: TcpEndpoint, error: Error): void;
    open(): readonly TcpEndpoint[];
    attempts(): readonly TcpEndpoint[];
  };
  readonly networkState: {
    givenFile(absolutePath: string, content: string): void;
    readFile(absolutePath: string): string;
  };
  readonly sessions: {
    givenActive(pid: number): void;
    givenMarker(pid: number | string): void;
    end(pid: number): void;
    markerExists(pid: number | string): boolean;
  };
  readonly idle: {
    waitForTick(): Promise<void>;
    advanceBy(milliseconds: number): Promise<void>;
    advanceToNextTick(): Promise<void>;
    pendingTicks(): number;
  };
  readonly settings: {
    givenInitialApply(result: ProcessResult): void;
    givenInitialApplyFailure(error: Error): void;
    givenFinalSync(result: ProcessResult): void;
    givenFinalSyncFailure(error: Error): void;
    initialApplyRequests(): number;
    finalSyncRequests(): number;
  };
  readonly cancellation: {
    cancelNetworkStartup(signal?: "SIGTERM" | "SIGINT"): void;
  };
  readonly cleanup: {
    events(): readonly string[];
    isDisposed(): boolean;
  };
  readonly clock: TestClock;
  readonly processes: ProcessTestHarness;
  readonly network: StatefulTcpService;
  [Symbol.asyncDispose](): Promise<void>;
}

const INITIAL_TIME = Date.UTC(2026, 0, 1);
const READY_FILE = "/tmp/.sandbox-ready";
const SESSIONS_DIRECTORY = "/tmp/sandbox-sessions";
const SETTINGS_COMMAND = "/usr/sbin/gosu";
const SETTINGS_APPLY_ARGS = [
  "sandbox",
  "/usr/local/bin/sandbox-container-tools",
  "settings",
  "apply",
] as const;
const FINAL_SYNC_ARGS = [
  "sandbox",
  "/usr/local/bin/sandbox-container-tools",
  "settings",
  "sync",
] as const;

function createContainerToolsChild(
  processes: ProcessTestHarness,
  name: string,
  childOptions: ChildOptions,
): ContainerToolsChild {
  const process = processes.expectStart({ match: { name } });
  let ready = childOptions.ready ?? false;
  const messages = [...(childOptions.messages ?? [])];
  for (const message of messages) process.emitStdout(`${message}\n`);
  return {
    get pid() {
      return process.pid;
    },
    get name() {
      return process.name;
    },
    get signals() {
      return process.signals;
    },
    messages,
    isReady: () => ready,
    markReady: () => {
      ready = true;
    },
    waitForSignal: () => process.waitForSignal(),
    exit: (options) => process.exit(options),
  };
}

export async function setupContainerToolsAppTest(
  options: ContainerToolsAppTestOptions = {},
): Promise<ContainerToolsAppTest> {
  const temporaryRoot = createTestDir("container-tools-app-test");
  const containerRoot = path.join(temporaryRoot, "container");
  const homeRoot = path.join(containerRoot, "home", "sandbox");
  fs.mkdirSync(homeRoot, { recursive: true });
  fs.mkdirSync(path.join(containerRoot, "proc"), { recursive: true });
  fs.writeFileSync(path.join(containerRoot, "proc", "mounts"), "");

  const environmentScope = createTestSandboxEnvironment({
    filesystemRoot: containerRoot,
    homeDirectory: homeRoot,
    variables: {
      HOME: homeRoot,
      ...options.variables,
    },
    platform: options.platform ?? "linux",
  });
  const terminal: TestTerminal = createTestTerminal();
  const clock = createTestClock(INITIAL_TIME);
  const writeLog = (message: string) => {
    terminal.io.stderr.write(`[container-tools] ${message}\n`);
  };
  const logger = createLogger(clock.clock, writeLog, {
    verbose: Boolean(options.variables?.SANDBOX_DEBUG),
    showElapsedTime: false,
  });
  const processes = createProcessTestHarness(clock.clock);
  let initialApplyOutcome: ProcessResult | Error = {
    exitCode: 0,
    stdout: "",
    stderr: "",
  };
  let finalSyncOutcome: ProcessResult | Error = {
    exitCode: 0,
    stdout: "",
    stderr: "",
  };
  const network = createStatefulTcpService();
  const version = options.version ?? "0.0.0-test";
  const executions = new Set<Promise<CliResult>>();
  const cleanupEvents: string[] = [];
  const sessions = new Map<number, TestProcess>();
  let disposed = false;

  const resolveContainerPath = (absolutePath: string) =>
    path.join(containerRoot, absolutePath.replace(/^\/+/, ""));

  function run(...args: string[]): Promise<CliResult> {
    if (disposed) throw new Error("The container-tools harness is disposed.");
    if (args[0] === "entrypoint") {
      const apply = processes.expectStart({
        match: { command: SETTINGS_COMMAND, args: SETTINGS_APPLY_ARGS },
      });
      if (initialApplyOutcome instanceof Error)
        apply.rejectResult(initialApplyOutcome);
      else apply.resolveResult(initialApplyOutcome);
      const sync = processes.expectStart({
        match: { command: SETTINGS_COMMAND, args: FINAL_SYNC_ARGS },
      });
      if (finalSyncOutcome instanceof Error)
        sync.rejectResult(finalSyncOutcome);
      else sync.resolveResult(finalSyncOutcome);
    }
    if (executions.size > 0) {
      throw new Error(
        "Only one container-tools execution may use an application terminal at a time.",
      );
    }
    const stdoutStart = terminal.stdout().length;
    const stderrStart = terminal.stderr().length;
    const execution = environmentScope.run(() =>
      runWithDependencies(
        [
          provideTerminal(terminal.io),
          provideClock(clock.clock),
          provideLogger(logger),
          provideProcessManager(processes.manager),
          provideTcpService(network.service),
        ],
        async () => {
          const exitCode = await runContainerToolsApplication(args, version);
          return {
            exitCode,
            stdout: terminal.stdout().slice(stdoutStart),
            stderr: terminal.stderr().slice(stderrStart),
          };
        },
      ),
    );
    executions.add(execution);
    void execution.finally(() => executions.delete(execution));
    return execution;
  }

  function writeFile(absolutePath: string, content: string): void {
    const filePath = resolveContainerPath(absolutePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  function sessionMarker(pid: number | string): string {
    return resolveContainerPath(
      path.posix.join(SESSIONS_DIRECTORY, String(pid)),
    );
  }

  async function waitForState(
    description: string,
    predicate: () => boolean,
  ): Promise<void> {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (predicate()) return;
      await Promise.resolve();
    }
    throw new Error(`Timed out waiting for ${description}.`);
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    cleanupEvents.push("cancellation");
    terminal.abort();
    processes.emitTermination("SIGTERM");
    await Promise.resolve();

    cleanupEvents.push("children-and-signals");
    await processes.dispose();
    cleanupEvents.push("timers");
    await clock.dispose();
    cleanupEvents.push("sockets");
    await network.dispose();
    cleanupEvents.push("executions");
    await Promise.allSettled([...executions]);
    cleanupEvents.push("terminal");
    await terminal.dispose();
    cleanupEvents.push("files-and-root");
    cleanupTestDir(temporaryRoot);
  }

  return createContainerToolsAppFixture({
    run,
    temporaryRoot,
    containerRoot,
    homeRoot,
    environment: environmentScope.environment,
    terminal,
    clock,
    processes,
    network,
    resolveContainerPath,
    writeFile,
    sessionMarker,
    waitForState,
    queueChild: (name, childOptions = {}) =>
      createContainerToolsChild(processes, name, childOptions),
    sessions,
    setInitialApplyOutcome: (outcome) => {
      initialApplyOutcome = outcome;
    },
    setFinalSyncOutcome: (outcome) => {
      finalSyncOutcome = outcome;
    },
    cleanupEvents,
    isDisposed: () => disposed,
    dispose,
  });
}

interface ContainerToolsAppFixtureContext {
  readonly run: (...args: string[]) => Promise<CliResult>;
  readonly temporaryRoot: string;
  readonly containerRoot: string;
  readonly homeRoot: string;
  readonly environment: SandboxEnvironment;
  readonly terminal: TestTerminal;
  readonly clock: TestClock;
  readonly processes: ProcessTestHarness;
  readonly network: StatefulTcpService;
  readonly resolveContainerPath: (absolutePath: string) => string;
  readonly writeFile: (absolutePath: string, content: string) => void;
  readonly sessionMarker: (pid: number | string) => string;
  readonly waitForState: (
    description: string,
    predicate: () => boolean,
  ) => Promise<void>;
  readonly queueChild: (
    name: string,
    options?: ChildOptions,
  ) => ContainerToolsChild;
  readonly sessions: Map<number, TestProcess>;
  readonly setInitialApplyOutcome: (outcome: ProcessResult | Error) => void;
  readonly setFinalSyncOutcome: (outcome: ProcessResult | Error) => void;
  readonly cleanupEvents: string[];
  readonly isDisposed: () => boolean;
  readonly dispose: () => Promise<void>;
}

function createContainerToolsAppFixture(
  context: ContainerToolsAppFixtureContext,
): ContainerToolsAppTest {
  const {
    run,
    temporaryRoot,
    containerRoot,
    homeRoot,
    environment,
    terminal,
    clock,
    processes,
    network,
    resolveContainerPath,
    writeFile,
    sessionMarker,
    waitForState,
    queueChild,
    sessions,
    setFinalSyncOutcome,
    cleanupEvents,
    isDisposed,
    dispose,
  } = context;

  return {
    cli: { run },
    entrypoint: {
      start: (...defaultCommand) => run("entrypoint", ...defaultCommand),
      isReady: () => fs.existsSync(resolveContainerPath(READY_FILE)),
      waitForReady: () =>
        waitForState("container readiness", () =>
          fs.existsSync(resolveContainerPath(READY_FILE)),
        ),
    },
    roots: {
      temporary: temporaryRoot,
      container: containerRoot,
      home: homeRoot,
    },
    environment,
    output: {
      stdout: () => terminal.stdout(),
      stderr: () => terminal.stderr(),
    },
    files: {
      write: writeFile,
      read: (absolutePath) =>
        fs.readFileSync(resolveContainerPath(absolutePath), "utf8"),
      exists: (absolutePath) =>
        fs.existsSync(resolveContainerPath(absolutePath)),
    },
    children: {
      givenRequired: (name, options) => queueChild(name, options),
      givenOptional: (name, options) => queueChild(name, options),
      async waitForSpawn(name) {
        await waitForState(`${name ?? "managed"} child spawn`, () =>
          processes.requests.some((request) => !name || request.name === name),
        );
      },
      events: processes.actions,
      pending: processes.pendingProcesses,
    },
    signals: {
      send: processes.emitTermination,
      subscriptions: processes.listenerCount,
    },
    sockets: {
      listen: network.givenListening,
      close: network.givenClosed,
      fail: network.givenFailure,
      open: network.openSockets,
      attempts: () => network.attempts().map((attempt) => attempt.endpoint),
    },
    networkState: {
      givenFile: writeFile,
      readFile: (absolutePath) =>
        fs.readFileSync(resolveContainerPath(absolutePath), "utf8"),
    },
    sessions: {
      givenActive(pid) {
        writeFile(path.posix.join(SESSIONS_DIRECTORY, String(pid)), "");
        writeFile(`/proc/${pid}/stat`, `${pid} (session) S 0 0 0`);
        const session = processes.addExternalProcess({ pid });
        session.exitOnSignal();
        sessions.set(pid, session);
      },
      givenMarker: (pid) =>
        writeFile(path.posix.join(SESSIONS_DIRECTORY, String(pid)), ""),
      end(pid) {
        sessions.get(pid)?.disappear();
        sessions.delete(pid);
        fs.rmSync(resolveContainerPath(`/proc/${pid}/stat`), { force: true });
      },
      markerExists: (pid) => fs.existsSync(sessionMarker(pid)),
    },
    idle: {
      waitForTick: clock.waitForSleep,
      advanceBy: clock.advanceBy,
      advanceToNextTick: clock.advanceToNext,
      pendingTicks: clock.pendingSleeps,
    },
    settings: {
      givenInitialApply: context.setInitialApplyOutcome,
      givenInitialApplyFailure: context.setInitialApplyOutcome,
      givenFinalSync: setFinalSyncOutcome,
      givenFinalSyncFailure: setFinalSyncOutcome,
      initialApplyRequests: () =>
        processes.requests.filter(
          (request) =>
            request.command === SETTINGS_COMMAND &&
            JSON.stringify(request.args ?? []) ===
              JSON.stringify(SETTINGS_APPLY_ARGS),
        ).length,
      finalSyncRequests: () =>
        processes.requests.filter(
          (request) =>
            request.command === SETTINGS_COMMAND &&
            JSON.stringify(request.args ?? []) ===
              JSON.stringify(FINAL_SYNC_ARGS),
        ).length,
    },
    cancellation: {
      cancelNetworkStartup: (signal = "SIGTERM") =>
        processes.emitTermination(signal),
    },
    cleanup: {
      events: () => [...cleanupEvents],
      isDisposed,
    },
    clock,
    processes,
    network,
    [Symbol.asyncDispose]: dispose,
  };
}
