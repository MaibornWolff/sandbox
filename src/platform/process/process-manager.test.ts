import { describe, expect, test } from "bun:test";
import type { Clock } from "#platform/clock/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import type { ProcessAdapter } from "./process-adapter.js";
import { createProcessManager } from "./process-lifecycle.js";
import {
  getProcessManager,
  provideProcessManager,
  type StandardProcessRequest,
  type StartProcessRequest,
  type StreamingProcessRequest,
} from "./process-manager.js";

const validRequests = [
  {
    command: "command",
    lifetime: "application",
    interaction: { mode: "non-interactive" },
    stdio: "capture",
  },
  {
    command: "interactive",
    lifetime: "application",
    interaction: { mode: "interactive", title: "agent" },
    stdio: "inherit",
  },
  {
    command: "editor",
    lifetime: "detached",
    interaction: { mode: "non-interactive" },
    stdio: "ignore",
    stdin: "ignore",
  },
  {
    command: "bridge",
    lifetime: "application",
    interaction: { mode: "non-interactive" },
    stdio: "stream",
  },
] as const satisfies readonly StartProcessRequest[];

// @ts-expect-error Detached interactive processes are invalid.
const detachedInteractive: StartProcessRequest = {
  command: "invalid",
  lifetime: "detached",
  interaction: { mode: "interactive" },
};

// @ts-expect-error Detached processes cannot inherit terminal streams.
const detachedInherited: StartProcessRequest = {
  command: "invalid",
  lifetime: "detached",
  interaction: { mode: "non-interactive" },
  stdio: "inherit",
};

// @ts-expect-error Interactive processes cannot configure output callbacks.
const interactiveCallback: StartProcessRequest = {
  command: "invalid",
  lifetime: "application",
  interaction: { mode: "interactive" },
  onStdout: () => undefined,
};

const streamingCallback: StreamingProcessRequest = {
  command: "invalid",
  lifetime: "application",
  interaction: { mode: "non-interactive" },
  stdio: "stream",
  // @ts-expect-error Streaming processes use their stdout iterator.
  onStdout: () => undefined,
};

const clock: Clock = {
  now: () => 0,
  sleep: () => Promise.resolve(),
};

function boundaryManager() {
  const adapter: ProcessAdapter = {
    start: () => {
      throw new Error("Adapter must not receive an invalid request.");
    },
    capture: () => ({ status: "missing" }),
    identityStatus: () => "missing",
    signal: () => undefined,
    unref: () => undefined,
    subscribeToSignals: () => () => undefined,
    setTitle: () => () => undefined,
  };
  return createProcessManager({ adapter, clock });
}

describe("process manager request model", () => {
  test("uses one scoped manager token", () => {
    expect(() => getProcessManager()).toThrow(
      'Dependency "process manager" is not registered in the active scope.',
    );
    const manager = boundaryManager();
    expect(
      runWithDependencies([provideProcessManager(manager)], getProcessManager),
    ).toBe(manager);
  });

  test("accepts every supported lifetime and interaction combination", () => {
    expect(validRequests).toHaveLength(4);
    expect(detachedInteractive.command).toBe("invalid");
    expect(detachedInherited.command).toBe("invalid");
    expect(interactiveCallback.command).toBe("invalid");
    expect(streamingCallback.command).toBe("invalid");
  });

  test.each([
    [
      {
        command: "invalid",
        lifetime: "detached",
        interaction: { mode: "interactive" },
      },
      "Detached processes cannot be interactive.",
    ],
    [
      {
        command: "invalid",
        lifetime: "detached",
        interaction: { mode: "non-interactive" },
        stdio: "inherit",
      },
      "Detached processes must ignore terminal streams.",
    ],
    [
      {
        command: "invalid",
        lifetime: "application",
        interaction: { mode: "interactive" },
        onStdout: (): void => undefined,
      },
      "Interactive processes cannot configure output callbacks or files.",
    ],
    [
      {
        command: "invalid",
        lifetime: "application",
        interaction: { mode: "non-interactive" },
        stdio: "stream",
        onStdout: (): void => undefined,
      },
      "Streaming processes expose dedicated input and output streams.",
    ],
  ])("rejects malformed JavaScript request %#", (request, message) => {
    expect(() =>
      boundaryManager().start(request as unknown as StandardProcessRequest),
    ).toThrow(message);
  });
});
