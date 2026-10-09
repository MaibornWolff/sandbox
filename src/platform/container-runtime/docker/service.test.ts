import { describe, expect, test } from "bun:test";
import { ExecError } from "#platform/process/index.js";
import { createStatefulRuntimeCommandExecutor } from "../__test__/index.js";
import { DockerService } from "./service.js";
import { createDockerVolumeOperations } from "./volumes.js";

describe("DockerService", () => {
  test("returns normalized and cached host readiness", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      { command: "docker", args: ["--version"] },
      "Docker version 24.0.7, build fixture\n",
    );
    commands.givenOutput(
      { command: "docker", args: ["info", "--format", "{{.MemTotal}}"] },
      "8345075712\n",
    );
    const service = new DockerService(commands.executor);

    await expect(service.ensureHostReady()).resolves.toEqual({
      version: "Docker version 24.0.7, build fixture",
      hostAccessName: "host.docker.internal",
      memory: { bytes: 8345075712, scope: "shared-runtime-vm" },
    });
    await service.ensureHostReady();
    expect(commands.events()).toHaveLength(2);
  });

  test("does not report runtime or parse failures as unknown memory", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      { command: "docker", args: ["--version"] },
      "Docker version 24.0.7\n",
    );
    commands.givenOutput(
      { command: "docker", args: ["info", "--format", "{{.MemTotal}}"] },
      "invalid\n",
    );
    await expect(
      new DockerService(commands.executor).ensureHostReady(),
    ).rejects.toThrow("Docker returned invalid runtime memory data");
  });

  test("distinguishes a missing volume from other inspect failures", async () => {
    const missing = createStatefulRuntimeCommandExecutor();
    missing.givenFailure(
      { command: "docker", args: ["volume", "inspect", "missing"] },
      new ExecError("inspect failed", 1, { stderr: "No such volume: missing" }),
    );
    await expect(
      createDockerVolumeOperations("docker", missing.executor).exists(
        "missing",
      ),
    ).resolves.toBe(false);

    const denied = createStatefulRuntimeCommandExecutor();
    const failure = new ExecError("inspect failed", 13, {
      stderr: "permission denied",
    });
    denied.givenFailure(
      { command: "docker", args: ["volume", "inspect", "private"] },
      failure,
    );
    await expect(
      createDockerVolumeOperations("docker", denied.executor).exists("private"),
    ).rejects.toBe(failure);
  });

  test("preserves runtime removal safety", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    const referenced = new ExecError("remove failed", 1, {
      stderr: "volume is in use",
    });
    commands.givenFailure(
      { command: "docker", args: ["volume", "rm", "sandbox-cache"] },
      referenced,
    );
    const volumes = createDockerVolumeOperations("docker", commands.executor);

    await expect(volumes.remove({ name: "sandbox-cache" })).rejects.toBe(
      referenced,
    );
  });

  test("keeps Docker disk recovery advice adapter-owned", () => {
    const service = new DockerService(
      createStatefulRuntimeCommandExecutor().executor,
    );
    expect(service.getDiskSpaceAdvice()).toContain("docker system prune");
  });
});
