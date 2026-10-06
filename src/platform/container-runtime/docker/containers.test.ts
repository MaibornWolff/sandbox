import { describe, expect, test } from "bun:test";
import { ExecError } from "#platform/process/index.js";
import { createStatefulRuntimeCommandExecutor } from "../__test__/index.js";
import { buildContainerRunArgs } from "../command-args.js";
import type { ContainerSpec } from "../container-contract.js";
import { createDockerContainerOperations } from "./containers.js";

const inspection = JSON.stringify([
  {
    Id: "container-1",
    Name: "/sandbox-project",
    Image: "sha256:image",
    Config: {
      Image: "sandbox-project:latest",
      Labels: { project: "alpha", hash: "123" },
    },
    State: { Status: "running", StartedAt: "2026-09-11T12:00:00Z" },
    Mounts: [
      {
        Type: "bind",
        Source: "C:\\project",
        Destination: "/workspace",
        RW: false,
      },
      {
        Type: "volume",
        Name: "sandbox-cache",
        Destination: "/var/cache",
        RW: true,
      },
    ],
  },
]);

function createSpec(): ContainerSpec {
  return {
    name: "sandbox-project",
    image: "sandbox-project:latest",
    labels: { project: "alpha" },
    environment: { SANDBOX: "1" },
    mounts: [
      {
        type: "bind",
        sourcePath: "C:\\project",
        targetPath: "/workspace",
        readOnly: true,
      },
    ],
    ports: [
      {
        hostAddress: "127.0.0.1",
        hostPort: 8080,
        containerPort: 80,
        protocol: "tcp",
      },
    ],
    init: true,
    removeOnExit: true,
    resources: { sharedMemorySize: "1g" },
    security: { capabilities: ["NET_ADMIN"], dockerInDocker: false },
  };
}

describe("Docker container operations", () => {
  test.each(["docker", "podman"] as const)(
    "reports %s name conflicts without changing other failures",
    async (runtime) => {
      const commands = createStatefulRuntimeCommandExecutor();
      const spec = createSpec();
      const command = {
        command: runtime,
        args: buildContainerRunArgs(spec, "detached", runtime),
      };
      const operations = createDockerContainerOperations({
        binaryName: runtime,
        runtime,
        exec: commands.executor,
      });
      const conflict = new ExecError(
        'The container name "sandbox-project" is already in use',
        125,
      );
      commands.givenFailure(command, conflict);
      await expect(operations.startDetached(spec)).rejects.toMatchObject({
        message: "Sandbox instance name is already in use: sandbox-project",
        cause: conflict,
      });
      const denied = new ExecError("permission denied", 126);
      commands.givenFailure(command, denied);
      await expect(operations.startDetached(spec)).rejects.toBe(denied);
    },
  );

  test("encodes typed detached container specifications", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    const expected = [
      "run",
      "-d",
      "--rm",
      "--init",
      "--name",
      "sandbox-project",
      "--label",
      "project=alpha",
      "-e",
      "SANDBOX=1",
      "-v",
      "C:\\project:/workspace:ro",
      "-p",
      "127.0.0.1:8080:80/tcp",
      "--cap-add",
      "NET_ADMIN",
      "--add-host=host.docker.internal:host-gateway",
      "--sysctl=net.ipv4.tcp_tw_reuse=1",
      "--sysctl=net.ipv4.ip_local_port_range=1024\t65535",
      "--sysctl=net.ipv4.tcp_fin_timeout=10",
      "--shm-size",
      "1g",
      "--ulimit",
      "nofile=65536:65536",
      "sandbox-project:latest",
    ];
    commands.givenOutput({ command: "docker", args: expected }, "container-1");
    const operations = createDockerContainerOperations({
      binaryName: "docker",
      runtime: "docker",
      exec: commands.executor,
    });
    await operations.startDetached(createSpec());
    expect(commands.events()[0]?.args).toEqual(expected);
  });

  test("uses conjunction for labels and disjunction for states", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: [
          "ps",
          "-a",
          "--filter",
          "label=project=alpha",
          "--filter",
          "label=managed",
          "--filter",
          "status=running",
          "--filter",
          "status=exited",
          "--format",
          "{{.ID}}",
        ],
      },
      "container-1\n",
    );
    commands.givenOutput(
      { command: "docker", args: ["inspect", "container-1"] },
      inspection,
    );
    const operations = createDockerContainerOperations({
      binaryName: "docker",
      runtime: "docker",
      exec: commands.executor,
    });
    await expect(
      operations.list({
        all: true,
        labels: { project: "alpha", managed: null },
        states: ["running", "exited"],
      }),
    ).resolves.toHaveLength(1);
  });

  test("normalizes inspection and preserves mount details", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      { command: "docker", args: ["inspect", "container-1"] },
      inspection,
    );
    const operations = createDockerContainerOperations({
      binaryName: "docker",
      runtime: "docker",
      exec: commands.executor,
    });
    await expect(operations.inspect("container-1")).resolves.toMatchObject({
      id: "container-1",
      name: "sandbox-project",
      imageIdentity: "sha256:image",
      state: "running",
      labels: { project: "alpha", hash: "123" },
      mounts: [
        {
          type: "bind",
          sourcePath: "C:\\project",
          targetPath: "/workspace",
          readOnly: true,
        },
        {
          type: "volume",
          volumeName: "sandbox-cache",
          targetPath: "/var/cache",
          readOnly: false,
        },
      ],
    });
  });

  test("returns null for absence and throws for malformed output", async () => {
    const missing = createStatefulRuntimeCommandExecutor();
    missing.givenFailure(
      { command: "docker", args: ["inspect", "missing"] },
      new ExecError("No such container", 1, { stderr: "No such container" }),
    );
    const missingOperations = createDockerContainerOperations({
      binaryName: "docker",
      runtime: "docker",
      exec: missing.executor,
    });
    await expect(missingOperations.inspect("missing")).resolves.toBeNull();

    const malformed = createStatefulRuntimeCommandExecutor();
    malformed.givenOutput(
      { command: "docker", args: ["inspect", "broken"] },
      "not-json",
    );
    const malformedOperations = createDockerContainerOperations({
      binaryName: "docker",
      runtime: "docker",
      exec: malformed.executor,
    });
    await expect(malformedOperations.inspect("broken")).rejects.toThrow(
      "invalid JSON",
    );
  });

  test("returns command output and nonzero exit codes", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenFailure(
      { command: "docker", args: ["exec", "container-1", "false"] },
      new ExecError("failed", 23, { stdout: "out", stderr: "err" }),
    );
    const operations = createDockerContainerOperations({
      binaryName: "docker",
      runtime: "docker",
      exec: commands.executor,
    });
    await expect(
      operations.exec("container-1", { command: ["false"] }),
    ).resolves.toEqual({ exitCode: 23, stdout: "out", stderr: "err" });
  });
});
