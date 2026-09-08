import { createSystemClock, provideClock } from "#platform/clock/index.js";
import {
  createNodeTcpService,
  provideTcpService,
} from "#platform/container-system/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  provideSandboxEnvironment,
  readSandboxProcessEnvironment,
} from "#platform/environment/index.js";
import {
  createLineWriter,
  createLogger,
  provideLogger,
} from "#platform/logging/index.js";
import {
  createNodeProcessManager,
  provideProcessManager,
  runWithProcessManager,
} from "#platform/process/index.js";
import {
  createProcessTerminal,
  type ProcessTerminalStreams,
  provideTerminal,
} from "#platform/terminal/index.js";
import { runContainerToolsApplication } from "./application.js";

export async function runProductionContainerToolsApplication(
  argv: readonly string[],
  version: string,
  terminalStreams: ProcessTerminalStreams,
): Promise<number> {
  const environment = readSandboxProcessEnvironment();
  const controller = new AbortController();
  const terminal = createProcessTerminal({
    signal: controller.signal,
    streams: terminalStreams,
  });
  const clock = createSystemClock();
  const writeLog = createLineWriter(terminal.stderr, "[container-tools] ");
  const logger = createLogger(clock, writeLog, {
    verbose: true,
    showElapsedTime: false,
  });
  const processManager = createNodeProcessManager({
    environment: {
      currentWorkingDirectory: environment.filesystemRoot,
      variables: environment.variables,
    },
    terminal,
    clock,
    logger,
  });
  const tcp = createNodeTcpService();

  try {
    return await runWithDependencies(
      [
        provideSandboxEnvironment(environment),
        provideTerminal(terminal),
        provideClock(clock),
        provideProcessManager(processManager),
        provideLogger(logger),
        provideTcpService(tcp),
      ],
      () =>
        runWithProcessManager(processManager, () =>
          runContainerToolsApplication(argv, version),
        ),
    );
  } finally {
    controller.abort();
  }
}
