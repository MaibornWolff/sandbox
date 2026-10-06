import * as fs from "node:fs";
import path from "node:path";
import {
  createTestClock,
  type TestClock,
} from "#platform/clock/__test__/index.js";
import { provideClock } from "#platform/clock/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createTestSandboxEnvironment } from "#platform/environment/__test__/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import {
  createProcessTestHarness,
  type ProcessTestHarness,
  type TestProcess,
} from "#platform/process/__test__/index.js";
import { provideProcessManager } from "#platform/process/index.js";
import {
  createTestTerminal,
  type TestTerminal,
} from "#platform/terminal/__test__/index.js";
import { provideTerminal } from "#platform/terminal/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { createContainerNetworkSystem } from "../network-bootstrap.js";
import { provideTcpService, type TcpEndpoint } from "../tcp-service.js";
import {
  createStatefulTcpService,
  type StatefulTcpService,
} from "./stateful-tcp-service.js";

type ContainerNetworkSystem = ReturnType<typeof createContainerNetworkSystem>;

export interface ContainerNetworkSystemTest {
  readonly root: string;
  readonly processes: ProcessTestHarness;
  readonly tcp: StatefulTcpService;
  readonly clock: TestClock;
  readonly output: {
    stderr(): string;
  };
  run<T>(
    operation: (system: ContainerNetworkSystem) => T | Promise<T>,
  ): Promise<T>;
  writeFile(absolutePath: string, content: string): void;
  readFile(absolutePath: string): string;
  fileExists(absolutePath: string): boolean;
  givenListening(endpoint: TcpEndpoint): void;
  givenClosed(endpoint: TcpEndpoint): void;
  givenConnectionFailure(endpoint: TcpEndpoint, error: Error): void;
  givenManagedChild(name: "dnsmasq" | "squid" | "tcpdump"): TestProcess;
  cancel(reason?: Error): void;
  [Symbol.asyncDispose](): Promise<void>;
}

export async function setupContainerNetworkSystemTest(
  variables: Readonly<Record<string, string>> = {},
): Promise<ContainerNetworkSystemTest> {
  const temporaryRoot = createTestDir("container-network-system-test");
  const root = path.join(temporaryRoot, "container");
  const home = path.join(root, "home", "sandbox");
  fs.mkdirSync(home, { recursive: true });
  const environment = createTestSandboxEnvironment({
    filesystemRoot: root,
    homeDirectory: home,
    variables: { HOME: home, ...variables },
    platform: "linux",
  });
  const clock = createTestClock();
  const processes = createProcessTestHarness(clock.clock);
  const tcp = createStatefulTcpService();
  const terminal: TestTerminal = createTestTerminal();
  const writeLog = (message: string) =>
    terminal.io.stderr.write(`${message}\n`);
  const logger = createLogger(clock.clock, writeLog, {
    verbose: Boolean(variables.SANDBOX_DEBUG),
    showElapsedTime: false,
  });
  const cancellation = new AbortController();
  const resolvePath = (absolutePath: string) =>
    path.join(root, absolutePath.replace(/^\/+/, ""));

  return {
    root,
    processes,
    tcp,
    clock,
    output: { stderr: () => terminal.stderr() },
    async run(operation) {
      return await environment.run(() =>
        runWithDependencies(
          [
            provideClock(clock.clock),
            provideProcessManager(processes.manager),
            provideTcpService(tcp.service),
            provideTerminal(terminal.io),
            provideLogger(logger),
          ],
          () =>
            operation(
              createContainerNetworkSystem({ signal: cancellation.signal }),
            ),
        ),
      );
    },
    writeFile(absolutePath, content) {
      const filePath = resolvePath(absolutePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    },
    readFile: (absolutePath) =>
      fs.readFileSync(resolvePath(absolutePath), "utf8"),
    fileExists: (absolutePath) => fs.existsSync(resolvePath(absolutePath)),
    givenListening: (endpoint) => tcp.givenListening(endpoint),
    givenClosed: (endpoint) => tcp.givenClosed(endpoint),
    givenConnectionFailure: (endpoint, error) =>
      tcp.givenFailure(endpoint, error),
    givenManagedChild: (name) => processes.expectStart({ match: { name } }),
    cancel(
      reason = new DOMException("Network startup was cancelled", "AbortError"),
    ) {
      cancellation.abort(reason);
    },
    async [Symbol.asyncDispose]() {
      terminal.abort();
      await terminal.dispose();
      cleanupTestDir(temporaryRoot);
    },
  };
}
