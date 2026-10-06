import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { createSystemClock, provideClock } from "#platform/clock/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { ExecError, provideProcessManager } from "#platform/process/index.js";
import {
  createProcessTerminal,
  provideTerminal,
} from "#platform/terminal/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { createStatefulRuntimeCommandExecutor } from "../__test__/index.js";
import type { SandboxInstanceSpec } from "../sandbox-contract.js";
import { createAppleContainerOperations } from "./containers.js";
import type { AppleNetworkOperations } from "./networking.js";

const readyNetwork: AppleNetworkOperations = {
  async prepareBuild() {},
  async prepareRun() {
    return {
      networkName: "default",
      environment: {},
      async [Symbol.asyncDispose]() {},
    };
  },
};

function containerInspection(
  digest = "sha256:alpha",
  state = "running",
  startedDate?: string,
): string {
  return JSON.stringify([
    {
      configuration: {
        id: "sandbox-alpha",
        image: {
          reference: "sandbox-alpha:latest",
          descriptor: { digest },
        },
      },
      status: { state, startedDate },
    },
  ]);
}

function createSpec(): SandboxInstanceSpec {
  return {
    name: "sandbox-alpha",
    image: {
      reference: "sandbox-alpha:latest",
      digest: "sha256:alpha",
    },
    labels: {},
    environment: {},
    mounts: [],
    ports: [],
    init: false,
    removeOnExit: false,
    resources: {},
    security: { capabilities: [], nestedContainerRuntime: false },
  };
}

const createArgs = [
  "create",
  "--name",
  "sandbox-alpha",
  "--network",
  "default",
  "-m",
  String(2 * 1024 ** 3),
  "--ulimit",
  "nofile=65536:65536",
  "sandbox-alpha:latest",
];

function createTerminal() {
  const controller = new AbortController();
  return createProcessTerminal({
    signal: controller.signal,
    streams: {
      input: Object.assign(new PassThrough(), { isTTY: true }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    },
  });
}

function createOperations(networking: AppleNetworkOperations = readyNetwork) {
  const commands = createStatefulRuntimeCommandExecutor();
  const operations = createAppleContainerOperations({
    exec: commands.executor,
    networking,
    getVolumeRoot: () => "/adapter-volumes",
    resolveMountSource: (mount) =>
      mount.type === "bind"
        ? mount.sourcePath
        : `/adapter-volumes/${mount.volumeName}`,
  });
  return { commands, operations };
}

function startPendingAttachedContainer(
  networking: AppleNetworkOperations = readyNetwork,
) {
  const clock = createTestClock();
  const logs: string[] = [];
  const processes = createProcessTestHarness(clock.clock);
  const child = processes.expectStart();
  const { commands, operations } = createOperations(networking);
  commands.givenOutput(
    { command: "container", args: createArgs },
    "sandbox-alpha",
  );
  commands.givenOutput(
    { command: "container", args: ["inspect", "sandbox-alpha"] },
    containerInspection("sha256:alpha", "stopped"),
  );
  commands.givenOutput(
    { command: "container", args: ["delete", "-f", "sandbox-alpha"] },
    "",
  );
  const execution = runWithDependencies(
    [
      provideProcessManager(processes.manager),
      provideTerminal(createTerminal()),
      provideClock(clock.clock),
      provideLogger(createLogger(clock.clock, (message) => logs.push(message))),
    ],
    () =>
      operations.runSandboxAttached(createSpec(), {
        attachStdin: false,
        allocateTerminal: false,
      }),
  );
  return { clock, child, commands, execution, logs };
}

describe("Apple container process operations", () => {
  test("recognizes a missing instance in the native nested error format", async () => {
    const { commands, operations } = createOperations();
    commands.givenFailure(
      { command: "container", args: ["inspect", "sandbox-alpha"] },
      new ExecError(
        'Error: notFound: "container with ID sandbox-alpha not found"',
        1,
      ),
    );
    await expect(operations.inspect("sandbox-alpha")).resolves.toBeNull();
  });

  test("distinguishes a never-started instance from a stopped instance", async () => {
    const { commands, operations } = createOperations();
    commands.givenOutput(
      { command: "container", args: ["inspect", "sandbox-alpha"] },
      containerInspection("sha256:alpha", "stopped"),
    );
    expect((await operations.inspect("sandbox-alpha"))?.state).toBe("created");
    commands.givenOutput(
      { command: "container", args: ["inspect", "sandbox-alpha"] },
      containerInspection("sha256:alpha", "stopped", "2026-10-01T14:00:00Z"),
    );
    expect((await operations.inspect("sandbox-alpha"))?.state).toBe("exited");
  });

  test("deletes an instance when the attached CLI exits before startup and preserves its exit code", async () => {
    const { clock, child, commands, execution } =
      startPendingAttachedContainer();
    await child.waitForStart();
    await clock.waitForSleep();
    child.resolveResult({
      exitCode: 125,
      stdout: "",
      stderr: "VM startup failed",
    });
    expect(await execution).toEqual({
      exitCode: 125,
      stdout: "",
      stderr: "VM startup failed",
    });
    expect(commands.events()).toContainEqual({
      command: "container",
      args: ["delete", "-f", "sandbox-alpha"],
    });
  });

  test("preserves the child exit code and warns when failed-start cleanup is denied", async () => {
    const { clock, child, commands, execution, logs } =
      startPendingAttachedContainer();
    await child.waitForStart();
    await clock.waitForSleep();
    commands.givenFailure(
      { command: "container", args: ["delete", "-f", "sandbox-alpha"] },
      new Error("deletion denied"),
    );
    child.resolveResult({
      exitCode: 125,
      stdout: "",
      stderr: "VM startup failed",
    });
    expect((await execution).exitCode).toBe(125);
    expect(logs.join("\n")).toContain("Could not remove failed Apple instance");
    expect(logs.join("\n")).toContain("deletion denied");
  });

  test.each([
    {
      failure: new ExecError("container not found: sandbox-alpha", 1),
      warning: false,
    },
    { failure: new Error("inspection unavailable"), warning: true },
  ])(
    "preserves the child result when final inspection fails: $failure.message",
    async ({ failure, warning }) => {
      const { clock, child, commands, execution, logs } =
        startPendingAttachedContainer();
      await child.waitForStart();
      await clock.waitForSleep();
      commands.givenFailure(
        { command: "container", args: ["inspect", "sandbox-alpha"] },
        failure,
      );
      child.resolveResult({
        exitCode: 17,
        stdout: "",
        stderr: "application failed",
      });
      expect((await execution).exitCode).toBe(17);
      expect(commands.events().some(({ args }) => args[0] === "delete")).toBe(
        false,
      );
      expect(logs.join("\n").includes("Could not check startup")).toBe(warning);
    },
  );

  test("retains a short-lived application that started and exited before inspection", async () => {
    const { clock, child, commands, execution } =
      startPendingAttachedContainer();
    await child.waitForStart();
    await clock.waitForSleep();
    commands.givenOutput(
      { command: "container", args: ["inspect", "sandbox-alpha"] },
      containerInspection("sha256:alpha", "stopped", "2026-09-15T12:00:00Z"),
    );
    child.resolveResult({
      exitCode: 17,
      stdout: "output",
      stderr: "app failed",
    });
    expect((await execution).exitCode).toBe(17);
    expect(commands.events().some(({ args }) => args[0] === "delete")).toBe(
      false,
    );
  });

  test("stops and awaits the attached child if startup inspection fails", async () => {
    const { clock, child, commands, execution } =
      startPendingAttachedContainer();
    let settled = false;
    const observed = execution.then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await child.waitForStart();
    await clock.waitForSleep();
    commands.givenFailure(
      { command: "container", args: ["inspect", "sandbox-alpha"] },
      new Error("attachment inspection failed"),
    );
    await clock.advanceBy(50);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeChild = settled;
    const signals = [...child.signals];
    child.resolveResult({ exitCode: 143, stdout: "", stderr: "" });
    const error = await observed;
    expect(settledBeforeChild).toBe(false);
    expect(signals).toEqual(["SIGTERM"]);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("attachment inspection failed");
    expect(commands.events()).toContainEqual({
      command: "container",
      args: ["delete", "-f", "sandbox-alpha"],
    });
  });

  test("warns on discovery cleanup failure without interrupting a started instance", async () => {
    const networking: AppleNetworkOperations = {
      async prepareBuild() {},
      async prepareRun() {
        return {
          networkName: "default",
          environment: {},
          async [Symbol.asyncDispose]() {
            throw new Error("helper deletion failed");
          },
        };
      },
    };
    const { clock, child, commands, execution, logs } =
      startPendingAttachedContainer(networking);
    const outcome = execution.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await child.waitForStart();
    await clock.waitForSleep();
    commands.givenOutput(
      { command: "container", args: ["inspect", "sandbox-alpha"] },
      containerInspection(),
    );
    await clock.advanceBy(50);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const signals = [...child.signals];
    const result = { exitCode: 17, stdout: "", stderr: "application failed" };
    child.resolveResult(result);
    expect(await outcome).toEqual({ result });
    expect(signals).toEqual([]);
    expect(commands.events().some(({ args }) => args[0] === "delete")).toBe(
      false,
    );
    expect(logs.join("\n")).toContain("helper deletion failed");
  });

  test("retains a started instance when the attached client fails", async () => {
    const { clock, child, commands, execution } =
      startPendingAttachedContainer();
    await child.waitForStart();
    await clock.waitForSleep();
    commands.givenOutput(
      { command: "container", args: ["inspect", "sandbox-alpha"] },
      containerInspection(),
    );
    await clock.advanceBy(50);
    child.rejectResult(new Error("attachment lost"));
    await expect(execution).rejects.toThrow("attachment lost");
    expect(commands.events().some(({ args }) => args[0] === "delete")).toBe(
      false,
    );
  });

  test("runs an attached container, forwards its signal, and preserves exit code", async () => {
    const processes = createProcessTestHarness();
    const child = processes.expectStart();
    const { commands, operations } = createOperations();
    commands.givenOutput(
      { command: "container", args: createArgs },
      "sandbox-alpha",
    );
    commands.givenOutput(
      {
        command: "container",
        args: ["kill", "--signal", "SIGTERM", "sandbox-alpha"],
      },
      "",
    );
    commands.givenOutput(
      { command: "container", args: ["inspect", "sandbox-alpha"] },
      containerInspection(),
    );

    const execution = runWithDependencies(
      [
        provideProcessManager(processes.manager),
        provideTerminal(createTerminal()),
      ],
      () =>
        operations.runSandboxAttached(createSpec(), {
          attachStdin: true,
          allocateTerminal: false,
          title: "sandbox-alpha",
        }),
    );
    expect(await child.waitForStart()).toMatchObject({
      command: "container",
      args: ["start", "--attach", "--interactive", "sandbox-alpha"],
      stdio: "inherit",
    });
    expect(processes.titles.current()).toBe("sandbox-alpha");

    processes.emitTermination("SIGTERM");
    await Promise.resolve();
    expect(child.signals).toEqual([]);
    expect(commands.events()).toEqual([
      { command: "container", args: createArgs },
      {
        command: "container",
        args: ["inspect", "sandbox-alpha"],
      },
      {
        command: "container",
        args: ["inspect", "sandbox-alpha"],
      },
      {
        command: "container",
        args: ["kill", "--signal", "SIGTERM", "sandbox-alpha"],
      },
    ]);
    child.resolveResult({ exitCode: 143, stdout: "", stderr: "" });
    expect((await execution).exitCode).toBe(143);
    expect(processes.titles.current()).toBeNull();
  });

  test("releases discovery after the foreground container attaches", async () => {
    let disposals = 0;
    const networking: AppleNetworkOperations = {
      async prepareBuild() {},
      async prepareRun() {
        return {
          networkName: "default",
          environment: {},
          async [Symbol.asyncDispose]() {
            disposals++;
          },
        };
      },
    };
    const processes = createProcessTestHarness();
    const child = processes.expectStart();
    const { commands, operations } = createOperations(networking);
    commands.givenOutput(
      { command: "container", args: createArgs },
      "sandbox-alpha",
    );
    commands.givenOutput(
      { command: "container", args: ["inspect", "sandbox-alpha"] },
      containerInspection(),
    );
    commands.givenOutput(
      {
        command: "container",
        args: ["kill", "--signal", "SIGTERM", "sandbox-alpha"],
      },
      "",
    );

    const execution = runWithDependencies(
      [
        provideProcessManager(processes.manager),
        provideTerminal(createTerminal()),
      ],
      () =>
        operations.runSandboxAttached(createSpec(), {
          attachStdin: true,
          allocateTerminal: false,
        }),
    );
    await child.waitForStart();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(disposals).toBe(1);
    expect(commands.events()).toContainEqual({
      command: "container",
      args: ["inspect", "sandbox-alpha"],
    });
    processes.emitTermination("SIGTERM");
    await Promise.resolve();
    expect(commands.events()).toContainEqual({
      command: "container",
      args: ["kill", "--signal", "SIGTERM", "sandbox-alpha"],
    });
    child.resolveResult({ exitCode: 143, stdout: "output", stderr: "error" });
    expect(await execution).toEqual({
      exitCode: 143,
      stdout: "output",
      stderr: "error",
    });
    expect(disposals).toBe(1);
  });

  test("releases discovery and deletes the instance when attached start fails", async () => {
    let disposals = 0;
    const networking: AppleNetworkOperations = {
      async prepareBuild() {},
      async prepareRun() {
        return {
          networkName: "default",
          environment: {},
          async [Symbol.asyncDispose]() {
            disposals++;
          },
        };
      },
    };
    const processes = createProcessTestHarness();
    const child = processes.expectStart();
    const { commands, operations } = createOperations(networking);
    commands.givenOutput(
      { command: "container", args: createArgs },
      "sandbox-alpha",
    );
    commands.givenOutput(
      { command: "container", args: ["inspect", "sandbox-alpha"] },
      containerInspection("sha256:alpha", "stopped"),
    );

    const execution = runWithDependencies(
      [
        provideProcessManager(processes.manager),
        provideTerminal(createTerminal()),
        provideClock(createSystemClock()),
        provideLogger(createLogger(createSystemClock(), () => {})),
      ],
      () =>
        operations.runSandboxAttached(createSpec(), {
          attachStdin: true,
          allocateTerminal: false,
        }),
    );
    await child.waitForStart();
    commands.givenOutput(
      { command: "container", args: ["delete", "-f", "sandbox-alpha"] },
      "",
    );
    child.rejectResult(new Error("foreground startup failed"));

    await expect(execution).rejects.toThrow("foreground startup failed");
    expect(disposals).toBe(1);
  });

  test("creates, verifies, and starts one detached instance", async () => {
    const { commands, operations } = createOperations();
    commands.givenOutput(
      { command: "container", args: createArgs },
      "sandbox-alpha",
    );
    commands.givenOutput(
      { command: "container", args: ["inspect", "sandbox-alpha"] },
      containerInspection("sha256:alpha", "stopped"),
    );
    commands.givenOutput(
      { command: "container", args: ["start", "sandbox-alpha"] },
      "",
    );

    await expect(
      operations.startSandboxDetached(createSpec()),
    ).resolves.toEqual({ id: "sandbox-alpha" });
    expect(commands.events()).toEqual([
      { command: "container", args: createArgs },
      { command: "container", args: ["inspect", "sandbox-alpha"] },
      { command: "container", args: ["start", "sandbox-alpha"] },
    ]);
  });

  test("deletes a stopped instance without starting it on digest mismatch", async () => {
    const { commands, operations } = createOperations();
    commands.givenOutput(
      { command: "container", args: createArgs },
      "sandbox-alpha",
    );
    commands.givenOutput(
      { command: "container", args: ["inspect", "sandbox-alpha"] },
      containerInspection("sha256:changed", "stopped"),
    );
    commands.givenOutput(
      { command: "container", args: ["delete", "sandbox-alpha"] },
      "",
    );

    await expect(operations.startSandboxDetached(createSpec())).rejects.toThrow(
      "from sha256:changed, expected sha256:alpha",
    );
    expect(commands.events()).toEqual([
      { command: "container", args: createArgs },
      { command: "container", args: ["inspect", "sandbox-alpha"] },
      { command: "container", args: ["delete", "sandbox-alpha"] },
    ]);
  });

  test("reports a native name conflict without deleting the other caller's instance", async () => {
    const { commands, operations } = createOperations();
    const failure = new ExecError(
      "Error: container already exists: sandbox-alpha",
      1,
    );
    commands.givenFailure({ command: "container", args: createArgs }, failure);
    await expect(
      operations.startSandboxDetached(createSpec()),
    ).rejects.toMatchObject({
      message: "Sandbox instance name is already in use: sandbox-alpha",
      cause: failure,
    });
    expect(commands.events().some((event) => event.args[0] === "delete")).toBe(
      false,
    );
  });

  test("does not delete a pre-existing instance when create fails", async () => {
    const { commands, operations } = createOperations();
    commands.givenFailure(
      { command: "container", args: createArgs },
      new Error("name already exists"),
    );

    await expect(operations.startSandboxDetached(createSpec())).rejects.toThrow(
      "name already exists",
    );
    expect(commands.events()).toEqual([
      { command: "container", args: createArgs },
    ]);
  });

  test("deletes the created instance when inspection fails", async () => {
    const { commands, operations } = createOperations();
    commands.givenOutput(
      { command: "container", args: createArgs },
      "sandbox-alpha",
    );
    commands.givenFailure(
      { command: "container", args: ["inspect", "sandbox-alpha"] },
      new Error("inspection failed"),
    );
    commands.givenOutput(
      { command: "container", args: ["delete", "sandbox-alpha"] },
      "",
    );

    await expect(operations.startSandboxDetached(createSpec())).rejects.toThrow(
      "inspection failed",
    );
    expect(commands.events().at(-1)).toEqual({
      command: "container",
      args: ["delete", "sandbox-alpha"],
    });
  });

  test("force-deletes the created instance when detached start fails", async () => {
    const { commands, operations } = createOperations();
    commands.givenOutput(
      { command: "container", args: createArgs },
      "sandbox-alpha",
    );
    commands.givenOutput(
      { command: "container", args: ["inspect", "sandbox-alpha"] },
      containerInspection("sha256:alpha", "stopped"),
    );
    commands.givenFailure(
      { command: "container", args: ["start", "sandbox-alpha"] },
      new Error("start failed"),
    );
    commands.givenOutput(
      { command: "container", args: ["delete", "-f", "sandbox-alpha"] },
      "",
    );

    await expect(operations.startSandboxDetached(createSpec())).rejects.toThrow(
      "start failed",
    );
    expect(commands.events().at(-1)).toEqual({
      command: "container",
      args: ["delete", "-f", "sandbox-alpha"],
    });
  });

  test("disposal stops and awaits only the Apple log reader", async () => {
    const processes = createProcessTestHarness();
    const child = processes.expectStart();
    const { commands, operations } = createOperations();
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    await runWithTestLogger(() =>
      runWithDependencies(
        [provideProcessManager(processes.manager)],
        async () => {
          const subscription = operations.followLogs("sandbox-alpha", {
            tail: 12,
            onOutput: (chunk) => output.push(chunk),
            onError: (chunk) => errors.push(chunk),
          });
          const request = await child.waitForStart();
          expect(request).toMatchObject({
            command: "container",
            args: ["logs", "--follow", "-n", "12", "sandbox-alpha"],
            stdin: "ignore",
            stdio: "ignore",
          });
          request.onStdout?.(Buffer.from("out"));
          request.onStderr?.(Buffer.from("err"));

          const stopping = subscription[Symbol.asyncDispose]();
          expect(child.signals).toEqual(["SIGTERM"]);
          child.exit({ signal: "SIGTERM" });
          await stopping;
          expect(await subscription.completion).toMatchObject({
            exitCode: 143,
          });
        },
      ),
    );
    expect(output.map(String)).toEqual(["out"]);
    expect(errors.map(String)).toEqual(["err"]);
    expect(commands.events()).toEqual([]);
  });
});
