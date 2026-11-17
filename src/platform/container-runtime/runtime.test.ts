import { describe, expect, test } from "bun:test";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import {
  createStatefulRuntimeCommandExecutor,
  type StatefulRuntimeCommandExecutor,
} from "./__test__/index.js";
import { DockerService } from "./docker/service.js";
import type { RuntimeExecutor } from "./executor.js";
import { probeRuntimes, resolveRuntime } from "./runtime.js";
import { DEFAULT_CONTAINER_RUNTIME_OPTIONS } from "./runtime-options.js";
import { createProductionRuntimeProvider } from "./runtime-provider.js";
import type { Runtime } from "./runtime-types.js";

async function resolveRuntimeInScope(
  configRuntime: string | undefined,
  exec: RuntimeExecutor,
  options: Parameters<typeof runWithTestLogger>[1] = {},
): Promise<Runtime> {
  const selection = await runWithTestLogger(
    () =>
      resolveRuntime(configRuntime, exec, DEFAULT_CONTAINER_RUNTIME_OPTIONS),
    options,
  );
  return selection.runtime.runtime;
}

const DOCKER_INFO = ["info", "--format", "{{.MemTotal}}"];

function givenDocker(
  commands: StatefulRuntimeCommandExecutor,
  state: "running" | "not-running" | "not-installed",
): void {
  if (state === "not-installed") {
    commands.givenFailure(
      { command: "docker", args: ["--version"] },
      new Error("not found"),
    );
    return;
  }
  commands.givenOutput(
    { command: "docker", args: ["--version"] },
    "Docker version 24.0.0",
  );
  if (state === "running") {
    commands.givenOutput(
      { command: "docker", args: DOCKER_INFO },
      "8589934592",
    );
  } else {
    commands.givenFailure(
      { command: "docker", args: DOCKER_INFO },
      new Error("Cannot connect to the Docker daemon"),
    );
  }
}

function givenPodman(
  commands: StatefulRuntimeCommandExecutor,
  state: "running" | "not-running" | "not-installed",
): void {
  if (state === "not-installed") {
    commands.givenFailure(
      { command: "podman", args: ["--version"] },
      new Error("not found"),
    );
    return;
  }
  commands.givenOutput(
    { command: "podman", args: ["--version"] },
    "podman version 4.0.0",
  );
  if (state === "running") {
    commands.givenOutput({ command: "podman", args: ["info"] }, "host: {}");
  } else {
    commands.givenFailure(
      { command: "podman", args: ["info"] },
      new Error("Cannot connect to Podman"),
    );
  }
}

function givenAppleContainer(
  commands: StatefulRuntimeCommandExecutor,
  serviceStatus: string,
): void {
  commands.givenOutput({ command: "uname", args: ["-m"] }, "arm64");
  commands.givenOutput(
    { command: "sw_vers", args: ["-productVersion"] },
    "26.5.1",
  );
  commands.givenOutput(
    { command: "container", args: ["--version"] },
    "container CLI version 1.4.1",
  );
  commands.givenOutput(
    { command: "container", args: ["system", "status", "--format", "json"] },
    JSON.stringify({ status: serviceStatus }),
  );
}

function commandNames(commands: StatefulRuntimeCommandExecutor): string[] {
  return commands.events().map((event) => event.command);
}

describe("resolveRuntime", () => {
  test("returns configured runtime directly", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    expect(await resolveRuntimeInScope("docker", commands.executor)).toBe(
      "docker",
    );
    expect(await resolveRuntimeInScope("podman", commands.executor)).toBe(
      "podman",
    );
    expect(
      await resolveRuntimeInScope("apple-container", commands.executor),
    ).toBe("apple-container");
    expect(commands.events()).toEqual([]);
  });

  test("selects the first running runtime in order", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    givenDocker(commands, "running");
    givenPodman(commands, "running");
    expect(await resolveRuntimeInScope(undefined, commands.executor)).toBe(
      "docker",
    );
  });

  test("prefers a running runtime over an installed runtime that is stopped", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    givenDocker(commands, "not-running");
    givenPodman(commands, "running");
    expect(await resolveRuntimeInScope(undefined, commands.executor)).toBe(
      "podman",
    );
  });

  test("falls back to the first installed runtime when none runs", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    givenDocker(commands, "not-running");
    givenPodman(commands, "not-running");
    expect(await resolveRuntimeInScope(undefined, commands.executor)).toBe(
      "docker",
    );
  });

  test("selects Apple container on macOS when it is the only running runtime", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    givenDocker(commands, "not-installed");
    givenPodman(commands, "not-installed");
    givenAppleContainer(commands, "running");
    expect(
      await resolveRuntimeInScope(undefined, commands.executor, {
        platform: "darwin",
      }),
    ).toBe("apple-container");
  });

  test("selects Docker without waiting for a Podman probe that hangs", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    givenDocker(commands, "running");
    const podmanSignals: (AbortSignal | undefined)[] = [];
    const executor: RuntimeExecutor = (command, args, options) => {
      if (command !== "podman")
        return commands.executor(command, args, options);
      podmanSignals.push(options?.signal);
      return new Promise<string>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () =>
          reject(options.signal?.reason),
        );
      });
    };

    const testClock = createTestClock();
    expect(
      await resolveRuntimeInScope(undefined, executor, {
        clock: testClock.clock,
      }),
    ).toBe("docker");
    expect(podmanSignals).toHaveLength(1);
    expect(podmanSignals[0]?.aborted).toBe(true);
    expect(testClock.pendingSleeps()).toBe(0);
  });

  test("reuses the ready service of the selected runtime", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    givenDocker(commands, "running");
    givenPodman(commands, "not-installed");
    commands.givenOutput(
      {
        command: "docker",
        args: ["ps", "--format", "{{.ID}}"],
      },
      "",
    );
    const requests: { args: string; signal?: AbortSignal }[] = [];
    const executor: RuntimeExecutor = (command, args, options) => {
      if (command === "docker")
        requests.push({
          args: (args ?? []).join(" "),
          signal: options?.signal,
        });
      return commands.executor(command, args, options);
    };

    const selection = await runWithTestLogger(async () => {
      const resolved = await resolveRuntime(
        undefined,
        executor,
        DEFAULT_CONTAINER_RUNTIME_OPTIONS,
      );
      await resolved.runtime.ensureHostReady();
      await resolved.runtime.instances.list();
      return resolved;
    });

    expect(selection.runtime).toBeInstanceOf(DockerService);
    expect(requests.map(({ args }) => args)).toEqual([
      "--version",
      DOCKER_INFO.join(" "),
      "ps --format {{.ID}}",
    ]);
    expect(requests.at(-1)?.signal?.aborted ?? false).toBe(false);
  });

  test("throws when no runtime is installed", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    givenDocker(commands, "not-installed");
    givenPodman(commands, "not-installed");
    commands.givenOutput(
      { command: "container", args: ["--version"] },
      "container CLI version 1.4.1",
    );
    await expect(
      resolveRuntimeInScope(undefined, commands.executor),
    ).rejects.toThrow(
      "No container runtime found. Install Docker, Podman, or Apple container.",
    );
    expect(commandNames(commands)).not.toContain("container");
  });
});

describe("probeRuntimes", () => {
  test("reports running, not-running, and not-installed runtimes", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    givenDocker(commands, "running");
    givenPodman(commands, "not-running");
    expect(
      await runWithTestLogger(() => probeRuntimes(commands.executor)),
    ).toEqual([
      {
        runtime: "docker",
        status: "running",
        version: "Docker version 24.0.0",
      },
      {
        runtime: "podman",
        status: "not-running",
        version: "podman version 4.0.0",
        hint: "Start Podman with podman machine start. On first use, run podman machine init first.",
      },
    ]);
    expect(commandNames(commands)).not.toContain("container");
  });

  test("reports Apple container with its start hint on macOS", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    givenDocker(commands, "not-running");
    givenPodman(commands, "not-installed");
    givenAppleContainer(commands, "stopped");
    expect(
      await runWithTestLogger(() => probeRuntimes(commands.executor), {
        platform: "darwin",
      }),
    ).toEqual([
      {
        runtime: "docker",
        status: "not-running",
        version: "Docker version 24.0.0",
        hint: "Start Docker with Rancher Desktop, Colima, or your preferred method.",
      },
      { runtime: "podman", status: "not-installed" },
      {
        runtime: "apple-container",
        status: "not-running",
        version: "container CLI version 1.4.1",
        hint: "Start the Apple container service with container system start.",
      },
    ]);
  });

  test("reports a host check that hangs as not-running after the timeout", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    givenPodman(commands, "running");
    const signals: (AbortSignal | undefined)[] = [];
    const hostCheckStarted = Promise.withResolvers<void>();
    const executor: RuntimeExecutor = (command, args, options) => {
      if (command !== "docker")
        return commands.executor(command, args, options);
      signals.push(options?.signal);
      if (args?.[0] === "--version") {
        return Promise.resolve("Docker version 24.0.0");
      }
      hostCheckStarted.resolve();
      return new Promise<string>(() => {});
    };

    const testClock = createTestClock();
    const probing = runWithTestLogger(() => probeRuntimes(executor), {
      clock: testClock.clock,
    });
    await hostCheckStarted.promise;
    await Bun.sleep(0);
    await testClock.advanceBy(5_000);
    const probes = await probing;

    expect(probes).toEqual([
      {
        runtime: "docker",
        status: "not-running",
        version: "Docker version 24.0.0",
      },
      { runtime: "podman", status: "running", version: "podman version 4.0.0" },
    ]);
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) expect(signal?.aborted).toBe(true);
  });
});

describe("production runtime provider", () => {
  test("resolves and creates through its owned process edge", async () => {
    const processes = createProcessTestHarness();
    processes
      .expectStart({ match: { command: "docker", args: ["--version"] } })
      .resolveResult({
        exitCode: 0,
        stdout: "Docker version 24.0.0",
        stderr: "",
      });
    processes
      .expectStart({ match: { command: "docker", args: DOCKER_INFO } })
      .resolveResult({ exitCode: 0, stdout: "8589934592", stderr: "" });

    const services = await runWithTestLogger(() =>
      createProductionRuntimeProvider(processes.manager).resolve(),
    );

    expect(services.runtime).toBeInstanceOf(DockerService);
    expect(Object.is(services.imageBuilder, services.runtime)).toBe(true);
    expect(services.runtime.runtime).toBe("docker");
    expect(services.imageOwnershipKey).toBe("docker");
    expect(
      processes.requests.map(({ command, args, stdio, signal }) => ({
        command,
        args,
        stdio,
        hasSignal: signal instanceof AbortSignal,
      })),
    ).toEqual([
      {
        command: "docker",
        args: ["--version"],
        stdio: "capture",
        hasSignal: true,
      },
      {
        command: "podman",
        args: ["--version"],
        stdio: "capture",
        hasSignal: true,
      },
      {
        command: "docker",
        args: DOCKER_INFO,
        stdio: "capture",
        hasSignal: true,
      },
    ]);
  });
});
