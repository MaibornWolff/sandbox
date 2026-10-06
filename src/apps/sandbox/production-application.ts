import {
  runUpdateCheckWorker,
  UPDATE_CHECK_WORKER_ARGUMENT,
} from "#modules/self-update/index.js";
import { createSystemClock, provideClock } from "#platform/clock/index.js";
import {
  createProductionRuntimeProvider,
  provideRuntimeProvider,
} from "#platform/container-runtime/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  provideHostEnvironment,
  readProcessEnvironment,
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
import {
  createNodeWebSocketService,
  provideWebSocketService,
} from "#platform/websocket/index.js";
import { createSandboxApplication } from "./application.js";

export async function runProductionSandboxApplication(
  argv: readonly string[],
  terminalStreams: ProcessTerminalStreams,
): Promise<number> {
  const environment = readProcessEnvironment();
  const controller = new AbortController();
  const terminal = createProcessTerminal({
    signal: controller.signal,
    streams: terminalStreams,
  });
  const clock = createSystemClock();
  const logger = createLogger(clock, createLineWriter(terminal.stderr));
  const processManager = createNodeProcessManager({
    environment,
    terminal,
    clock,
    logger,
  });
  const runtimeProvider = createProductionRuntimeProvider(processManager);
  const webSocketService = createNodeWebSocketService();

  try {
    return await runWithDependencies(
      [
        provideHostEnvironment(environment),
        provideTerminal(terminal),
        provideClock(clock),
        provideProcessManager(processManager),
        provideLogger(logger),
        provideRuntimeProvider(runtimeProvider),
        provideWebSocketService(webSocketService),
      ],
      () =>
        runWithProcessManager(processManager, async () => {
          if (argv[0] === UPDATE_CHECK_WORKER_ARGUMENT && argv.length === 2) {
            await runUpdateCheckWorker(argv[1] ?? "");
            return 0;
          }
          return createSandboxApplication().run(argv);
        }),
    );
  } finally {
    controller.abort();
  }
}
