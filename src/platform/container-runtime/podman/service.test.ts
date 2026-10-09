import { describe, expect, test } from "bun:test";
import { ExecError } from "#platform/process/index.js";
import { createStatefulRuntimeCommandExecutor } from "../__test__/index.js";
import { PodmanService } from "./service.js";

describe("PodmanService", () => {
  test("returns Podman-owned normalized host readiness", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      { command: "podman", args: ["--version"] },
      "podman version 5.0.0\n",
    );
    commands.givenOutput(
      { command: "podman", args: ["info"] },
      "host: fixture\n",
    );
    const service = new PodmanService(commands.executor);

    await expect(service.ensureHostReady()).resolves.toEqual({
      version: "podman version 5.0.0",
      hostAccessName: "host.containers.internal",
      memory: { bytes: null, scope: "unknown" },
    });
  });

  test("reports Podman-owned recovery instructions", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      { command: "podman", args: ["--version"] },
      "podman version 5.0.0\n",
    );
    commands.givenFailure(
      { command: "podman", args: ["info"] },
      new Error("machine stopped"),
    );
    const service = new PodmanService(commands.executor);

    await expect(service.ensureHostReady()).rejects.toThrow(
      /Podman is not running[\s\S]*podman machine start/,
    );
    expect(service.getDiskSpaceAdvice()).toContain("podman system prune");
  });

  test("keeps Podman state alternatives in Podman-owned code", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    for (const state of ["exited", "stopped"]) {
      commands.givenOutput(
        {
          command: "podman",
          args: [
            "ps",
            "-a",
            "--filter",
            `status=${state}`,
            "--format",
            "{{.ID}}",
          ],
        },
        "",
      );
    }
    const service = new PodmanService(commands.executor);
    await service.instances.list({ all: true, states: ["exited"] });
    expect(commands.events()).toHaveLength(2);
  });

  test("uses Podman volume commands through the grouped adapter", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenFailure(
      { command: "podman", args: ["volume", "inspect", "cache"] },
      new ExecError("missing", 1, { stderr: "no such volume" }),
    );
    commands.givenOutput(
      { command: "podman", args: ["volume", "create", "cache"] },
      "cache\n",
    );
    const service = new PodmanService(commands.executor);
    await service.storage.ensure({ key: "cache", scope: "global" });
    expect(commands.events()).toEqual([
      { command: "podman", args: ["volume", "inspect", "cache"] },
      { command: "podman", args: ["volume", "create", "cache"] },
    ]);
  });
});
