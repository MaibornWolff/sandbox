import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { type Clock, provideClock } from "#platform/clock/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createHostEnvironment,
  provideHostEnvironment,
} from "#platform/environment/index.js";
import { createGitFixture } from "#platform/git/__test__/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { provideProcessManager } from "#platform/process/index.js";
import { createTestTerminal } from "#platform/terminal/__test__/index.js";
import {
  createProcessTerminal,
  provideTerminal,
} from "#platform/terminal/index.js";

interface HostTestScopeOptions {
  readonly root: string;
  readonly variables?: Readonly<Record<string, string>>;
  readonly verbose?: boolean;
}

interface HostTestScopeResult<T> {
  readonly result: T;
  readonly stdout: string;
  readonly stderr: string;
  readonly processes: ReturnType<typeof createProcessTestHarness>;
}

export function createHostGitFixture(
  processes: ReturnType<typeof createProcessTestHarness>,
) {
  return createGitFixture(processes);
}

export function runWithTestLogger<T>(
  callback: () => T,
  options: {
    readonly variables?: Readonly<Record<string, string>>;
    readonly clock?: Clock;
    readonly platform?: NodeJS.Platform;
    readonly currentWorkingDirectory?: string;
    readonly homeDirectory?: string;
  } = {},
): T {
  const clock = options.clock ?? createTestClock(Date.UTC(2026, 0, 1)).clock;
  const logger = createLogger(clock, () => {});
  const controller = new AbortController();
  const terminal = createProcessTerminal({
    signal: controller.signal,
    streams: {
      input: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    },
  });
  const environment = createHostEnvironment({
    currentWorkingDirectory: options.currentWorkingDirectory ?? "/test/project",
    homeDirectory: options.homeDirectory ?? "/test/home",
    variables: options.variables ?? {},
    platform: options.platform ?? "linux",
    interactive: true,
  });
  const processes = createProcessTestHarness();
  return runWithDependencies(
    [
      provideHostEnvironment(environment),
      provideClock(clock),
      provideTerminal(terminal),
      provideProcessManager(processes.manager),
      provideLogger(logger),
    ],
    callback,
  );
}

export async function runInHostTestScope<T>(
  options: HostTestScopeOptions,
  callback: (context: {
    readonly processes: ReturnType<typeof createProcessTestHarness>;
  }) => Promise<T> | T,
): Promise<HostTestScopeResult<T>> {
  const configRoot = path.join(options.root, "config");
  const homeRoot = path.join(options.root, "home");
  const dataRoot = path.join(options.root, "data");
  for (const directory of [configRoot, homeRoot, dataRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const terminal = createTestTerminal();
  const clock = createTestClock(Date.UTC(2026, 0, 1));
  const environment = createHostEnvironment({
    currentWorkingDirectory: options.root,
    homeDirectory: homeRoot,
    variables: {
      SANDBOX_CONFIG_DIR: configRoot,
      XDG_CONFIG_HOME: configRoot,
      XDG_DATA_HOME: dataRoot,
      ...options.variables,
    },
    platform: "linux",
    interactive: true,
  });
  const processes = createProcessTestHarness();
  const logger = createLogger(
    clock.clock,
    (message) => terminal.io.stderr.write(`${message}\n`),
    { verbose: options.verbose },
  );

  try {
    const result = await runWithDependencies(
      [
        provideHostEnvironment(environment),
        provideClock(clock.clock),
        provideTerminal(terminal.io),
        provideProcessManager(processes.manager),
        provideLogger(logger),
      ],
      () => callback({ processes }),
    );
    return {
      result,
      stdout: terminal.stdout(),
      stderr: terminal.stderr(),
      processes,
    };
  } finally {
    await terminal.dispose();
  }
}
