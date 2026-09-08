import { describe, expect, test } from "bun:test";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createHostEnvironment,
  provideHostEnvironment,
} from "#platform/environment/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import { createStatefulRuntimeCommandExecutor } from "../__test__/index.js";
import { PodmanService } from "./service.js";

async function runWithPodmanTestScope<T>(
  variables: Readonly<Record<string, string>>,
  callback: () => Promise<T>,
): Promise<{ readonly result: T; readonly output: string }> {
  const output: string[] = [];
  const clock = {
    now: () => 0,
    sleep: () => Promise.resolve(),
  };
  const result = await runWithDependencies(
    [
      provideHostEnvironment(
        createHostEnvironment({
          currentWorkingDirectory: "/project",
          homeDirectory: "/home/test",
          variables,
          platform: "linux",
          interactive: false,
        }),
      ),
      provideLogger(
        createLogger(clock, (message) => output.push(message), {
          verbose: true,
        }),
      ),
    ],
    callback,
  );
  return { result, output: output.join("\n") };
}

describe("PodmanService", () => {
  test("runtime is podman", () => {
    const svc = new PodmanService(
      createStatefulRuntimeCommandExecutor().executor,
    );
    expect(svc.runtime).toBe("podman");
    expect(svc.binaryName).toBe("podman");
  });

  test("creates with init and stops before removal", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "podman",
        args: [
          "run",
          "-d",
          "--rm",
          "--init",
          "--name",
          "managed",
          "sandbox-base:latest",
        ],
      },
      "",
    );
    commands.givenOutput({ command: "podman", args: ["stop", "managed"] }, "");
    commands.givenOutput({ command: "podman", args: ["rm", "managed"] }, "");
    const svc = new PodmanService(commands.executor);

    await svc.createContainer({
      name: "managed",
      image: "sandbox-base:latest",
    });
    await svc.stopContainer("managed");

    expect(commands.events()).toEqual([
      {
        command: "podman",
        args: [
          "run",
          "-d",
          "--rm",
          "--init",
          "--name",
          "managed",
          "sandbox-base:latest",
        ],
      },
      { command: "podman", args: ["stop", "managed"] },
      { command: "podman", args: ["rm", "managed"] },
    ]);
  });

  test("getBuildEnv returns empty (no DOCKER_BUILDKIT)", () => {
    const svc = new PodmanService(
      createStatefulRuntimeCommandExecutor().executor,
    );
    expect(svc.getBuildEnv()).toEqual({});
  });

  test("buildImage does not include --load", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "podman",
        args: ["build", "-t", "test:latest", "-f", "/tmp/Dockerfile", "/tmp"],
      },
      "",
    );
    const svc = new PodmanService(commands.executor);
    await runWithPodmanTestScope({}, () =>
      svc.buildImage({
        tag: "test:latest",
        dockerfilePath: "/tmp/Dockerfile",
        contextDir: "/tmp",
      }),
    );
    const args = commands.events()[0]?.args ?? [];
    expect(args).not.toContain("--load");
    expect(args).toContain("build");
    expect(args).toContain("test:latest");
  });

  test("buildImage disables interactive output when silent", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "podman",
        args: ["build", "-t", "test:latest", "-f", "/tmp/Dockerfile", "/tmp"],
      },
      "",
    );
    const svc = new PodmanService(commands.executor);
    await runWithPodmanTestScope({}, () =>
      svc.buildImage({
        tag: "test:latest",
        dockerfilePath: "/tmp/Dockerfile",
        contextDir: "/tmp",
        silent: true,
      }),
    );

    const opts = commands.events()[0]?.options;
    expect(opts?.interactive).toBe(false);
  });

  test("buildImage converts secrets to --build-arg instead of --secret", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "podman",
        args: [
          "build",
          "--build-arg",
          "GITHUB_TOKEN=test-token",
          "-t",
          "test:latest",
          "-f",
          "/tmp/Dockerfile",
          "/tmp",
        ],
      },
      "",
    );
    const svc = new PodmanService(commands.executor);
    await runWithPodmanTestScope({ GITHUB_TOKEN: "test-token" }, () =>
      svc.buildImage({
        tag: "test:latest",
        dockerfilePath: "/tmp/Dockerfile",
        contextDir: "/tmp",
        secrets: [{ id: "GITHUB_TOKEN", env: "GITHUB_TOKEN" }],
      }),
    );
    const args = commands.events()[0]?.args ?? [];
    expect(args).not.toContain("--secret");
    expect(args).toContain("--build-arg");
    expect(args).toContain("GITHUB_TOKEN=test-token");
  });

  test("buildImage omits scoped secrets that are absent", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "podman",
        args: ["build", "-t", "test:latest", "-f", "/tmp/Dockerfile", "/tmp"],
      },
      "",
    );
    const svc = new PodmanService(commands.executor);

    await runWithPodmanTestScope({}, () =>
      svc.buildImage({
        tag: "test:latest",
        dockerfilePath: "/tmp/Dockerfile",
        contextDir: "/tmp",
        secrets: [{ id: "GITHUB_TOKEN", env: "GITHUB_TOKEN" }],
      }),
    );

    const args = commands.events()[0]?.args ?? [];
    expect(args).not.toContain("--secret");
    expect(args).not.toContain("--build-arg");
  });

  test("buildImage redacts converted secret build args in debug logs", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "podman",
        args: [
          "build",
          "--build-arg",
          "GITHUB_TOKEN=ghp_secret",
          "-t",
          "test:latest",
          "-f",
          "/tmp/Dockerfile",
          "/tmp",
        ],
      },
      "",
    );
    const svc = new PodmanService(commands.executor);
    const { output } = await runWithPodmanTestScope(
      { GITHUB_TOKEN: "ghp_secret" },
      () =>
        svc.buildImage({
          tag: "test:latest",
          dockerfilePath: "/tmp/Dockerfile",
          contextDir: "/tmp",
          secrets: [{ id: "GITHUB_TOKEN", env: "GITHUB_TOKEN" }],
          silent: true,
        }),
    );

    const args = commands.events()[0]?.args ?? [];
    expect(args).toContain("GITHUB_TOKEN=ghp_secret");
    expect(output).toContain("GITHUB_TOKEN=<redacted>");
    expect(output).not.toContain("ghp_secret");
  });

  test("getBuildSecretArgs returns --build-arg format", () => {
    const svc = new PodmanService(
      createStatefulRuntimeCommandExecutor().executor,
    );
    expect(svc.getBuildSecretArgs("GITHUB_TOKEN", "GITHUB_TOKEN")).toEqual([
      "--build-arg",
      "GITHUB_TOKEN=$GITHUB_TOKEN",
    ]);
  });

  test("inherits unfiltered listContainers from DockerService", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "podman",
        args: ["ps", "--format", "{{.ID}}|{{.Names}}|{{.Image}}"],
      },
      "abc|ctr|img\n",
    );
    const svc = new PodmanService(commands.executor);
    const result = await svc.listContainers();
    expect(commands.events()).toEqual([
      {
        command: "podman",
        args: ["ps", "--format", "{{.ID}}|{{.Names}}|{{.Image}}"],
      },
    ]);
    expect(result).toHaveLength(1);
  });

  test("treats an empty status filter as unfiltered", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "podman",
        args: ["ps", "-a", "--format", "{{.ID}}|{{.Names}}|{{.Image}}"],
      },
      "abc|ctr|img\n",
    );
    const svc = new PodmanService(commands.executor);

    const result = await svc.listContainers({ all: true, statusFilter: [] });

    expect(result.map(({ id }) => id)).toEqual(["abc"]);
    expect(commands.events()).toHaveLength(1);
  });

  test("translates Podman status alternatives and deduplicates containers", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    const format = "{{.ID}}|{{.Names}}|{{.Image}}";
    commands.givenOutput(
      {
        command: "podman",
        args: [
          "ps",
          "-a",
          "--filter",
          "label=sandbox.project=project-a1b2",
          "--filter",
          "status=exited",
          "--format",
          format,
        ],
      },
      "abc|stopped|img\n",
    );
    commands.givenOutput(
      {
        command: "podman",
        args: [
          "ps",
          "-a",
          "--filter",
          "label=sandbox.project=project-a1b2",
          "--filter",
          "status=stopped",
          "--format",
          format,
        ],
      },
      "abc|stopped|img\n",
    );
    commands.givenOutput(
      {
        command: "podman",
        args: [
          "ps",
          "-a",
          "--filter",
          "label=sandbox.project=project-a1b2",
          "--filter",
          "status=unknown",
          "--format",
          format,
        ],
      },
      "def|unknown|img\n",
    );
    const svc = new PodmanService(commands.executor);

    const result = await svc.listContainers({
      all: true,
      labelFilter: "sandbox.project=project-a1b2",
      statusFilter: ["exited", "dead"],
    });

    expect(result.map(({ id }) => id)).toEqual(["abc", "def"]);
    expect(commands.events()).toHaveLength(3);
  });

  test("getRuntimeRunFlags uses private networking and Podman-safe limits", () => {
    const svc = new PodmanService(
      createStatefulRuntimeCommandExecutor().executor,
    );
    const flags = svc.getRuntimeRunFlags();
    expect(flags).toContain("--network=private");
    expect(flags).toContain("--cgroups=disabled");
    expect(flags).toContain("--cap-add=NET_ADMIN");
    expect(flags).toContain("nofile=65535:65535");
    expect(flags).not.toContain("nofile=65536:65536");
  });

  test("getHostInternalDns returns host.containers.internal", () => {
    const svc = new PodmanService(
      createStatefulRuntimeCommandExecutor().executor,
    );
    expect(svc.getHostInternalDns()).toBe("host.containers.internal");
  });

  test("ensureHostSetup throws Podman-specific error when daemon is not running", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenFailure(
      { command: "podman", args: ["info"] },
      new Error("Cannot connect to Podman"),
    );
    const svc = new PodmanService(commands.executor);

    await expect(svc.ensureHostSetup()).rejects.toThrow(
      "Podman is not running",
    );
    expect(commands.events()).toEqual([{ command: "podman", args: ["info"] }]);
  });

  test("ensureHostSetup succeeds when daemon is running", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      { command: "podman", args: ["info"] },
      "some podman info output",
    );
    const svc = new PodmanService(commands.executor);

    await expect(svc.ensureHostSetup()).resolves.toEqual({
      memoryBytes: null,
    });
  });

  test("getInstallHint mentions Podman", () => {
    const svc = new PodmanService(
      createStatefulRuntimeCommandExecutor().executor,
    );
    expect(svc.getInstallHint()).toContain("Podman");
  });

  test("getPruneHint mentions podman", () => {
    const svc = new PodmanService(
      createStatefulRuntimeCommandExecutor().executor,
    );
    expect(svc.getPruneHint()).toContain("podman system prune");
  });
});
