import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { provideProcessManager } from "#platform/process/index.js";
import {
  createProcessTerminal,
  provideTerminal,
} from "#platform/terminal/index.js";
import { createStatefulRuntimeCommandExecutor } from "./__test__/index.js";
import { DockerService } from "./docker/service.js";
import { runInteractiveContainerRuntimeProcess } from "./interactive-process.js";

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

describe("interactive container runtime process", () => {
  test("inherits terminal IO, forwards signals, and restores the title", async () => {
    const processes = createProcessTestHarness();
    const child = processes.expectStart();
    const execution = runWithDependencies(
      [
        provideProcessManager(processes.manager),
        provideTerminal(createTerminal()),
      ],
      () =>
        runInteractiveContainerRuntimeProcess(
          { binaryName: "podman" },
          { args: ["exec", "sandbox-project", "zsh"], title: "zsh" },
        ),
    );

    expect(await child.waitForStart()).toMatchObject({
      command: "podman",
      args: ["exec", "sandbox-project", "zsh"],
      stdio: "inherit",
      name: "container runtime interactive execution",
    });
    expect(processes.titles.current()).toBe("zsh");
    processes.emitTermination("SIGTERM");
    processes.emitTermination("SIGINT");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);

    child.resolveResult({ exitCode: 42, stdout: "", stderr: "" });
    expect(await execution).toEqual({ exitCode: 42, stdout: "", stderr: "" });
    expect(processes.titles.current()).toBeNull();
  });

  test("routes handled signals without interrupting the runtime client", async () => {
    const processes = createProcessTestHarness();
    const child = processes.expectStart();
    const forwarded: NodeJS.Signals[] = [];
    const execution = runWithDependencies(
      [
        provideProcessManager(processes.manager),
        provideTerminal(createTerminal()),
      ],
      () =>
        runInteractiveContainerRuntimeProcess(
          { binaryName: "docker" },
          {
            args: ["exec", "sandbox-project", "sandbox", "escape", "sleep"],
            forwardSignal: async (signal) => {
              forwarded.push(signal);
              return true;
            },
          },
        ),
    );
    await child.waitForStart();

    processes.emitTermination("SIGINT");
    await Promise.resolve();

    expect(forwarded).toEqual(["SIGINT"]);
    expect(child.signals).toEqual([]);
    child.resolveResult({ exitCode: 130, stdout: "", stderr: "" });
    expect((await execution).exitCode).toBe(130);
  });

  test("signals a foreground container instead of the runtime client", async () => {
    const processes = createProcessTestHarness();
    const child = processes.expectStart();
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: ["kill", "--signal", "SIGTERM", "sandbox-project"],
      },
      "",
    );
    const runtime = new DockerService(commands.executor);
    const execution = runWithDependencies(
      [
        provideProcessManager(processes.manager),
        provideTerminal(createTerminal()),
      ],
      () =>
        runInteractiveContainerRuntimeProcess(runtime, {
          args: ["run", "--name", "sandbox-project", "image"],
          signalContainer: "sandbox-project",
        }),
    );
    await child.waitForStart();

    processes.emitTermination("SIGTERM");
    await Promise.resolve();

    expect(child.signals).toEqual([]);
    expect(commands.events()).toEqual([
      {
        command: "docker",
        args: ["kill", "--signal", "SIGTERM", "sandbox-project"],
      },
    ]);
    child.resolveResult({
      exitCode: 143,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
    });
    expect((await execution).exitCode).toBe(143);
  });

  test("restores title and subscriptions when spawning fails", async () => {
    const processes = createProcessTestHarness();
    const child = processes.expectStart();
    const execution = runWithDependencies(
      [
        provideProcessManager(processes.manager),
        provideTerminal(createTerminal()),
      ],
      () =>
        runInteractiveContainerRuntimeProcess(
          { binaryName: "docker" },
          { args: ["run"], title: "sandbox" },
        ),
    );
    await child.waitForStart();
    child.rejectResult(new Error("spawn failed"));
    await expect(execution).rejects.toThrow("spawn failed");
    expect(processes.titles.current()).toBeNull();
    processes.emitTermination("SIGTERM");
    expect(child.signals).toEqual([]);
  });
});
