import { describe, expect, test } from "bun:test";
import { createStatefulRuntimeCommandExecutor } from "./stateful-runtime-command-executor.js";

describe("stateful runtime command executor", () => {
  test("rejects unconfigured commands with the complete runtime request", async () => {
    const commands = createStatefulRuntimeCommandExecutor();

    await expect(
      commands.executor(
        "docker.exe",
        ["build", "C:\\workspace", "--build-arg", "API_TOKEN=arg-secret"],
        {
          env: { AUTH_TOKEN: "env-secret", BUILDKIT_PROGRESS: "plain" },
          interactive: true,
        },
      ),
    ).rejects.toThrow(
      'Unexpected runtime command: executable="docker.exe", args=["build","C:\\\\workspace","--build-arg","API_TOKEN=<redacted>"], stdio=inherit, options={"env":{"AUTH_TOKEN":"<redacted>","BUILDKIT_PROGRESS":"plain"},"interactive":true}.',
    );
  });

  test("preserves configured output, failures, options, and event snapshots", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    const outputRequest = { command: "docker", args: ["inspect", "image"] };
    const failureRequest = { command: "podman", args: ["pull", "missing"] };
    const failure = Object.assign(new Error("runtime stderr"), {
      exitCode: 37,
      stderr: "pull failed\n",
      stdout: "partial output\n",
    });
    const env = { DOCKER_BUILDKIT: "1" };

    commands.givenOutput(outputRequest, "sha256:abc\n");
    commands.givenFailure(failureRequest, failure);

    await expect(
      commands.executor(outputRequest.command, outputRequest.args, {
        env,
        interactive: false,
      }),
    ).resolves.toBe("sha256:abc\n");
    await expect(
      commands.executor(failureRequest.command, failureRequest.args),
    ).rejects.toBe(failure);

    env.DOCKER_BUILDKIT = "changed";
    expect(commands.events()).toEqual([
      {
        ...outputRequest,
        options: { env: { DOCKER_BUILDKIT: "1" }, interactive: false },
      },
      failureRequest,
    ]);
    expect(failure).toMatchObject({
      exitCode: 37,
      stderr: "pull failed\n",
      stdout: "partial output\n",
    });
  });
});
