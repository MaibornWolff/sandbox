import { describe, expect, test } from "bun:test";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { createStatefulRuntimeCommandExecutor } from "./__test__/index.js";
import { DockerService } from "./docker/service.js";
import { resolveRuntime } from "./runtime.js";
import { createProductionRuntimeProvider } from "./runtime-provider.js";

const resolveRuntimeInScope: typeof resolveRuntime = (...args) =>
  runWithTestLogger(() => resolveRuntime(...args));

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

  test("auto-detects docker first", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      { command: "docker", args: ["--version"] },
      "Docker version 24.0.0",
    );
    expect(await resolveRuntimeInScope(undefined, commands.executor)).toBe(
      "docker",
    );
    expect(commands.events()).toEqual([
      { command: "docker", args: ["--version"] },
    ]);
  });

  test("falls back to podman", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenFailure(
      { command: "docker", args: ["--version"] },
      new Error("not found"),
    );
    commands.givenOutput(
      { command: "podman", args: ["--version"] },
      "podman version 4.0.0",
    );
    expect(await resolveRuntimeInScope(undefined, commands.executor)).toBe(
      "podman",
    );
    expect(commands.events()).toEqual([
      { command: "docker", args: ["--version"] },
      { command: "podman", args: ["--version"] },
    ]);
  });

  test("falls back to Apple container after Podman", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenFailure(
      { command: "docker", args: ["--version"] },
      new Error("not found"),
    );
    commands.givenFailure(
      { command: "podman", args: ["--version"] },
      new Error("not found"),
    );
    commands.givenOutput(
      { command: "container", args: ["--version"] },
      "container CLI version 1.4.1",
    );
    expect(await resolveRuntimeInScope(undefined, commands.executor)).toBe(
      "apple-container",
    );
    expect(commands.events()).toEqual([
      { command: "docker", args: ["--version"] },
      { command: "podman", args: ["--version"] },
      { command: "container", args: ["--version"] },
    ]);
  });

  test("throws when no runtime found", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    for (const command of ["docker", "podman", "container"]) {
      commands.givenFailure(
        { command, args: ["--version"] },
        new Error("not found"),
      );
    }
    await expect(
      resolveRuntimeInScope(undefined, commands.executor),
    ).rejects.toThrow("No container runtime found");
    expect(commands.events()).toEqual([
      { command: "docker", args: ["--version"] },
      { command: "podman", args: ["--version"] },
      { command: "container", args: ["--version"] },
    ]);
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

    const services = await runWithTestLogger(() =>
      createProductionRuntimeProvider(processes.manager).resolve(),
    );

    expect(services.runtime).toBeInstanceOf(DockerService);
    expect(Object.is(services.imageBuilder, services.runtime)).toBe(true);
    expect(services.runtime.runtime).toBe("docker");
    expect(services.imageOwnershipKey).toBe("docker");
    expect(processes.requests).toEqual([
      {
        command: "docker",
        args: ["--version"],
        stdio: "capture",
      },
    ]);
  });
});
