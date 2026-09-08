import { describe, expect, test } from "bun:test";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import { ExecError } from "#platform/process/index.js";
import { createStatefulRuntimeCommandExecutor } from "../__test__/index.js";
import { DockerService } from "./service.js";

function runWithDockerLogger<T>(callback: () => T, messages: string[] = []): T {
  return runWithDependencies(
    [
      provideLogger(
        createLogger(
          {
            now: () => 0,
            sleep: () => Promise.resolve(),
          },
          (message) => messages.push(message),
          { verbose: true },
        ),
      ),
    ],
    callback,
  );
}

describe("DockerService", () => {
  // -- Detection / system -------------------------------------------------

  test("getVersion calls docker --version", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      { command: "docker", args: ["--version"] },
      "Docker version 24.0.7, build afdd53b\n",
    );
    const svc = new DockerService(commands.executor);
    const version = await svc.getVersion();
    expect(version).toBe("Docker version 24.0.7, build afdd53b");
    expect(commands.events()).toEqual([
      { command: "docker", args: ["--version"] },
    ]);
  });

  test("getMemoryBytes parses memory", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: ["info", "--format", "{{.MemTotal}}"],
      },
      "8345075712\n",
    );
    const svc = new DockerService(commands.executor);
    const mem = await svc.getMemoryBytes();
    expect(mem).toBe(8345075712);
  });

  test("getMemoryBytes returns null for malformed output or discovery failure", async () => {
    const request = {
      command: "docker",
      args: ["info", "--format", "{{.MemTotal}}"],
    };
    const malformed = createStatefulRuntimeCommandExecutor();
    malformed.givenOutput(request, "not-a-number\n");
    expect(
      await new DockerService(malformed.executor).getMemoryBytes(),
    ).toBeNull();

    const failed = createStatefulRuntimeCommandExecutor();
    failed.givenFailure(request, new Error("no docker"));
    expect(
      await new DockerService(failed.executor).getMemoryBytes(),
    ).toBeNull();
  });

  // -- Container lifecycle ------------------------------------------------

  test("listContainers builds correct filter args", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: [
          "ps",
          "--filter",
          "label=sandbox.project=test",
          "--filter",
          "status=running",
          "--format",
          "{{.ID}}|{{.Names}}|{{.Image}}",
        ],
      },
      "abc123|my-ctr|ubuntu:24.04\n",
    );
    const svc = new DockerService(commands.executor);
    const result = await svc.listContainers({
      labelFilter: "sandbox.project=test",
      statusFilter: ["running"],
    });
    expect(commands.events()).toEqual([
      {
        command: "docker",
        args: [
          "ps",
          "--filter",
          "label=sandbox.project=test",
          "--filter",
          "status=running",
          "--format",
          "{{.ID}}|{{.Names}}|{{.Image}}",
        ],
      },
    ]);
    expect(result).toEqual([
      { id: "abc123", name: "my-ctr", image: "ubuntu:24.04" },
    ]);
  });

  test("listContainers reads requested labels in the same command", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: [
          "ps",
          "--format",
          '{{.ID}}|{{.Names}}|{{.Image}}|{{.Label "sandbox.hash"}}',
        ],
      },
      "abc123|my-ctr|ubuntu:24.04|hash-1\n",
    );

    const result = await new DockerService(commands.executor).listContainers({
      labelKeys: ["sandbox.hash"],
    });

    expect(result).toEqual([
      {
        id: "abc123",
        name: "my-ctr",
        image: "ubuntu:24.04",
        labels: { "sandbox.hash": "hash-1" },
      },
    ]);
  });

  test("listContainers returns only well-formed entries and normalizes local images", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    const request = {
      command: "docker",
      args: ["ps", "-a", "--format", "{{.ID}}|{{.Names}}|{{.Image}}"],
    };
    commands.givenOutput(
      request,
      "malformed\nabc|sandbox|localhost/sandbox-user:latest\nmissing|image\n",
    );
    const result = await new DockerService(commands.executor).listContainers({
      all: true,
    });

    expect(result).toEqual([
      { id: "abc", name: "sandbox", image: "sandbox-user:latest" },
    ]);
    expect(commands.events()).toEqual([request]);
  });

  test("listContainers treats command failure as no discovered containers", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    const request = {
      command: "docker",
      args: ["ps", "--format", "{{.ID}}|{{.Names}}|{{.Image}}"],
    };
    commands.givenFailure(request, new Error("daemon unavailable"));

    expect(await new DockerService(commands.executor).listContainers()).toEqual(
      [],
    );
  });

  test("createContainer starts containers with an init process", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: [
          "run",
          "-d",
          "--rm",
          "--init",
          "--name",
          "test-ctr",
          "--label",
          "sandbox.project=slug",
          "--label",
          "sandbox.hash=abc",
          "-v",
          "/a:/a:rw",
          "sandbox-base:latest",
        ],
      },
      "",
    );
    const svc = new DockerService(commands.executor);
    await svc.createContainer({
      name: "test-ctr",
      labels: { "sandbox.project": "slug", "sandbox.hash": "abc" },
      extraArgs: ["-v", "/a:/a:rw"],
      image: "sandbox-base:latest",
    });
    const args = commands.events()[0]?.args ?? [];
    expect(args[0]).toBe("run");
    expect(args[1]).toBe("-d");
    expect(args[2]).toBe("--rm");
    expect(args[3]).toBe("--init");
    expect(args).toContain("test-ctr");
    expect(args).toContain("sandbox-base:latest");
  });

  test("signals containers and stops them gracefully before removal", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: ["kill", "--signal", "SIGINT", "running"],
      },
      "",
    );
    commands.givenOutput({ command: "docker", args: ["stop", "running"] }, "");
    commands.givenOutput({ command: "docker", args: ["rm", "running"] }, "");
    const svc = new DockerService(commands.executor);

    await svc.signalContainer("running", "SIGINT");
    await svc.stopContainer("running");

    expect(commands.events()).toEqual([
      {
        command: "docker",
        args: ["kill", "--signal", "SIGINT", "running"],
      },
      { command: "docker", args: ["stop", "running"] },
      { command: "docker", args: ["rm", "running"] },
    ]);
  });

  test("accepts auto-removal after a graceful stop", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      { command: "docker", args: ["stop", "ephemeral"] },
      "",
    );
    commands.givenFailure(
      { command: "docker", args: ["rm", "ephemeral"] },
      new ExecError("container was auto-removed", 1, {
        stderr: "Error: No such container: ephemeral",
      }),
    );
    const svc = new DockerService(commands.executor);

    await expect(svc.stopContainer("ephemeral")).resolves.toBeUndefined();
  });

  test("removeContainer preserves optional force semantics", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      { command: "docker", args: ["rm", "-f", "forced"] },
      "",
    );
    commands.givenOutput({ command: "docker", args: ["rm", "ordinary"] }, "");
    const svc = new DockerService(commands.executor);
    await svc.removeContainer("forced", true);
    await svc.removeContainer("ordinary");
    expect(commands.events()).toEqual([
      { command: "docker", args: ["rm", "-f", "forced"] },
      { command: "docker", args: ["rm", "ordinary"] },
    ]);
  });

  test("waitUntilContainerReady uses one bounded exec request", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: [
          "exec",
          "ctr",
          "sh",
          "-c",
          'i=0; while [ "$i" -lt 100 ]; do [ -f /tmp/.sandbox-ready ] && exit 0; i=$((i + 1)); sleep 0.05; done; exit 124',
        ],
      },
      "",
    );

    await new DockerService(commands.executor).waitUntilContainerReady(
      "ctr",
      5_000,
    );

    expect(commands.events()).toHaveLength(1);
  });

  test("execInContainer passes options", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: [
          "exec",
          "-u",
          "root",
          "-w",
          "/app",
          "-e",
          "FOO=bar",
          "ctr",
          "ls",
          "-la",
        ],
      },
      "output\n",
    );
    const svc = new DockerService(commands.executor);
    await svc.execInContainer("ctr", ["ls", "-la"], {
      user: "root",
      workdir: "/app",
      env: { FOO: "bar" },
    });
    const args = commands.events()[0]?.args ?? [];
    expect(args).toContain("-u");
    expect(args).toContain("root");
    expect(args).toContain("-w");
    expect(args).toContain("/app");
    expect(args).toContain("-e");
    expect(args).toContain("FOO=bar");
    expect(args).toContain("ctr");
    expect(args).toContain("ls");
  });

  test("getContainerState and logs return exact runtime output semantics", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: ["inspect", "--format", "{{.State.Status}}", "abc"],
      },
      "running\n",
    );
    commands.givenOutput(
      { command: "docker", args: ["logs", "--tail", "50", "abc"] },
      "started\nready\n",
    );
    const svc = new DockerService(commands.executor);
    expect(await svc.getContainerState("abc")).toBe("running");
    expect(await svc.getContainerLogs("abc")).toBe("started\nready\n");
  });

  test("getContainerLabel returns null for <no value>", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: [
          "inspect",
          "--format",
          '{{index .Config.Labels "sandbox.hash"}}',
          "abc",
        ],
      },
      "<no value>\n",
    );
    const svc = new DockerService(commands.executor);
    expect(await svc.getContainerLabel("abc", "sandbox.hash")).toBeNull();
  });

  test("getContainerLabel returns value", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: [
          "inspect",
          "--format",
          '{{index .Config.Labels "sandbox.hash"}}',
          "ctr",
        ],
      },
      "abc123\n",
    );
    const svc = new DockerService(commands.executor);
    expect(await svc.getContainerLabel("ctr", "sandbox.hash")).toBe("abc123");
  });

  test("container metadata degrades to null or unknown when absent or failing", async () => {
    const emptyLabel = createStatefulRuntimeCommandExecutor();
    emptyLabel.givenOutput(
      {
        command: "docker",
        args: [
          "inspect",
          "--format",
          '{{index .Config.Labels "sandbox.hash"}}',
          "empty",
        ],
      },
      "  \n",
    );
    expect(
      await new DockerService(emptyLabel.executor).getContainerLabel(
        "empty",
        "sandbox.hash",
      ),
    ).toBeNull();

    const failedLabel = createStatefulRuntimeCommandExecutor();
    failedLabel.givenFailure(
      {
        command: "docker",
        args: [
          "inspect",
          "--format",
          '{{index .Config.Labels "sandbox.hash"}}',
          "missing",
        ],
      },
      new Error("container not found"),
    );
    expect(
      await new DockerService(failedLabel.executor).getContainerLabel(
        "missing",
        "sandbox.hash",
      ),
    ).toBeNull();

    const unknownUptime = createStatefulRuntimeCommandExecutor();
    unknownUptime.givenOutput(
      {
        command: "docker",
        args: ["ps", "--filter", "id=stopped", "--format", "{{.RunningFor}}"],
      },
      "\n",
    );
    expect(
      await new DockerService(unknownUptime.executor).getContainerUptime(
        "stopped",
      ),
    ).toBe("unknown");

    const failedUptime = createStatefulRuntimeCommandExecutor();
    failedUptime.givenFailure(
      {
        command: "docker",
        args: ["ps", "--filter", "id=missing", "--format", "{{.RunningFor}}"],
      },
      new Error("daemon unavailable"),
    );
    expect(
      await new DockerService(failedUptime.executor).getContainerUptime(
        "missing",
      ),
    ).toBe("unknown");
  });

  // -- Image operations ---------------------------------------------------

  test("listImageReferences filters dangling references and handles discovery failure", async () => {
    const request = {
      command: "docker",
      args: ["images", "--format", "{{.Repository}}:{{.Tag}}"],
    };
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      request,
      "sandbox-base:latest\n<none>:<none>\nregistry/app:v2\n",
    );
    expect(
      await new DockerService(commands.executor).listImageReferences(),
    ).toEqual(["sandbox-base:latest", "registry/app:v2"]);

    const failed = createStatefulRuntimeCommandExecutor();
    failed.givenFailure(request, new Error("daemon unavailable"));
    expect(
      await new DockerService(failed.executor).listImageReferences(),
    ).toEqual([]);
  });

  test("imageExists returns true for non-empty output", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: ["images", "-q", "sandbox-base:latest"],
      },
      "sha256:abc\n",
    );
    const svc = new DockerService(commands.executor);
    expect(await svc.imageExists("sandbox-base:latest")).toBe(true);
  });

  test("imageExists returns false for empty output or discovery failure", async () => {
    const empty = createStatefulRuntimeCommandExecutor();
    empty.givenOutput(
      { command: "docker", args: ["images", "-q", "missing"] },
      "\n",
    );
    expect(await new DockerService(empty.executor).imageExists("missing")).toBe(
      false,
    );

    const failed = createStatefulRuntimeCommandExecutor();
    failed.givenFailure(
      { command: "docker", args: ["images", "-q", "nonexistent"] },
      new Error("not found"),
    );
    expect(
      await new DockerService(failed.executor).imageExists("nonexistent"),
    ).toBe(false);
  });

  test("inspectImage reads its ID and requested labels together", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: [
          "image",
          "inspect",
          "--format",
          '{{.Id}}|{{index .Config.Labels "dockerfile.hash"}}',
          "sandbox-user:latest",
        ],
      },
      "sha256:abc|hash-1\n",
    );

    await expect(
      new DockerService(commands.executor).inspectImage("sandbox-user:latest", [
        "dockerfile.hash",
      ]),
    ).resolves.toEqual({
      id: "sha256:abc",
      labels: { "dockerfile.hash": "hash-1" },
    });
  });

  test("getImageLabel returns a value or null for absent and failing images", async () => {
    const request = (name: string) => ({
      command: "docker",
      args: [
        "inspect",
        "--format",
        '{{index .Config.Labels "dockerfile.hash"}}',
        name,
      ],
    });
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(request("current"), "hash-123\n");
    commands.givenOutput(request("unlabelled"), "<no value>\n");
    commands.givenFailure(request("missing"), new Error("image not found"));
    const svc = new DockerService(commands.executor);

    expect(await svc.getImageLabel("current", "dockerfile.hash")).toBe(
      "hash-123",
    );
    expect(await svc.getImageLabel("unlabelled", "dockerfile.hash")).toBeNull();
    expect(await svc.getImageLabel("missing", "dockerfile.hash")).toBeNull();
  });

  test("buildImage includes --load and DOCKER_BUILDKIT", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: [
          "build",
          "--load",
          "--build-arg",
          "HOST_UID=1000",
          "--label",
          "dockerfile.hash=abc",
          "-t",
          "test:latest",
          "-f",
          "/tmp/Dockerfile",
          "/tmp",
        ],
      },
      "",
    );
    const svc = new DockerService(commands.executor);
    await runWithDockerLogger(() =>
      svc.buildImage({
        tag: "test:latest",
        dockerfilePath: "/tmp/Dockerfile",
        contextDir: "/tmp",
        buildArgs: { HOST_UID: "1000" },
        labels: { "dockerfile.hash": "abc" },
      }),
    );
    const args = commands.events()[0]?.args ?? [];
    expect(args).toContain("--load");
    expect(args).toContain("test:latest");
    const opts = commands.events()[0]?.options;
    expect(opts?.env?.DOCKER_BUILDKIT).toBe("1");
  });

  test("buildImage disables interactive output when silent", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: [
          "build",
          "--load",
          "-t",
          "test:latest",
          "-f",
          "/tmp/Dockerfile",
          "/tmp",
        ],
      },
      "",
    );
    const svc = new DockerService(commands.executor);
    await runWithDockerLogger(() =>
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

  test("buildImage passes secrets", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: [
          "build",
          "--load",
          "--secret",
          "id=GITHUB_TOKEN,env=GITHUB_TOKEN",
          "-t",
          "test:latest",
          "-f",
          "/tmp/Dockerfile",
          "/tmp",
        ],
      },
      "",
    );
    const svc = new DockerService(commands.executor);
    await runWithDockerLogger(() =>
      svc.buildImage({
        tag: "test:latest",
        dockerfilePath: "/tmp/Dockerfile",
        contextDir: "/tmp",
        secrets: [{ id: "GITHUB_TOKEN", env: "GITHUB_TOKEN" }],
      }),
    );
    const args = commands.events()[0]?.args ?? [];
    expect(args).toContain("--secret");
    expect(args).toContain("id=GITHUB_TOKEN,env=GITHUB_TOKEN");
  });

  test("buildImage redacts build args in debug logs without changing exec args", async () => {
    const messages: string[] = [];
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: [
          "build",
          "--load",
          "--build-arg",
          "GITHUB_TOKEN=ghp_secret",
          "--build-arg",
          "HOST_UID=1000",
          "-t",
          "test:latest",
          "-f",
          "/tmp/Dockerfile",
          "/tmp",
        ],
      },
      "",
    );
    const svc = new DockerService(commands.executor);

    await runWithDockerLogger(
      () =>
        svc.buildImage({
          tag: "test:latest",
          dockerfilePath: "/tmp/Dockerfile",
          contextDir: "/tmp",
          buildArgs: { GITHUB_TOKEN: "ghp_secret", HOST_UID: "1000" },
          silent: true,
        }),
      messages,
    );

    const args = commands.events()[0]?.args ?? [];
    expect(args).toContain("GITHUB_TOKEN=ghp_secret");
    const debugMessage = messages.join("\n");
    expect(debugMessage).toContain("GITHUB_TOKEN=<redacted>");
    expect(debugMessage).toContain("HOST_UID=1000");
    expect(debugMessage).not.toContain("ghp_secret");
  });

  test("getImageId returns trimmed id", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: ["image", "inspect", "--format", "{{.Id}}", "test"],
      },
      "sha256:abc123\n",
    );
    const svc = new DockerService(commands.executor);
    expect(await svc.getImageId("test")).toBe("sha256:abc123");
  });

  test("listDanglingImages filters malformed rows and parses Docker sizes", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    const request = {
      command: "docker",
      args: [
        "images",
        "--filter",
        "dangling=true",
        "--filter",
        "reference=sandbox-*",
        "--format",
        "{{.ID}}|{{.Size}}|{{.CreatedAt}}",
      ],
    };
    commands.givenOutput(
      request,
      [
        "sha256:small|850B|2026-07-01 10:00:00 +0000 UTC",
        "malformed",
        "sha256:missing-size||2026-07-01",
        " sha256:large | 1.5GB | 2026-06-01 ",
      ].join("\n"),
    );

    expect(
      await new DockerService(commands.executor).listDanglingImages(
        "sandbox-*",
      ),
    ).toEqual([
      {
        id: "sha256:small",
        size: 850,
        created: "2026-07-01 10:00:00 +0000 UTC",
      },
      { id: "sha256:large", size: 1_500_000_000, created: "2026-06-01" },
    ]);
    expect(commands.events()).toEqual([request]);
  });

  test("listDanglingImages returns empty output for no matches or command failure", async () => {
    const request = {
      command: "docker",
      args: [
        "images",
        "--filter",
        "dangling=true",
        "--filter",
        "reference=none-*",
        "--format",
        "{{.ID}}|{{.Size}}|{{.CreatedAt}}",
      ],
    };
    const empty = createStatefulRuntimeCommandExecutor();
    empty.givenOutput(request, "\n");
    expect(
      await new DockerService(empty.executor).listDanglingImages("none-*"),
    ).toEqual([]);

    const failed = createStatefulRuntimeCommandExecutor();
    failed.givenFailure(request, new Error("daemon unavailable"));
    expect(
      await new DockerService(failed.executor).listDanglingImages("none-*"),
    ).toEqual([]);
  });

  test("getContainersUsingImage returns ancestor container ids and handles failures", async () => {
    const request = (imageId: string) => ({
      command: "docker",
      args: [
        "ps",
        "-a",
        "--filter",
        `ancestor=${imageId}`,
        "--format",
        "{{.ID}}",
      ],
    });
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(request("sha256:used"), "container-a\ncontainer-b\n");
    commands.givenOutput(request("sha256:unused"), "\n");
    commands.givenFailure(
      request("sha256:unknown"),
      new Error("daemon unavailable"),
    );
    const svc = new DockerService(commands.executor);

    expect(await svc.getContainersUsingImage("sha256:used")).toEqual([
      "container-a",
      "container-b",
    ]);
    expect(await svc.getContainersUsingImage("sha256:unused")).toEqual([]);
    expect(await svc.getContainersUsingImage("sha256:unknown")).toEqual([]);
  });

  test("pull, tag, and remove use exact Docker boundaries", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "docker",
        args: ["pull", "registry.example/base:latest"],
      },
      "",
    );
    commands.givenOutput(
      {
        command: "docker",
        args: ["tag", "legacy:latest", "sandbox-base:latest"],
      },
      "",
    );
    commands.givenOutput(
      { command: "docker", args: ["rmi", "sha256:old"] },
      "",
    );
    const svc = new DockerService(commands.executor);
    await svc.pullImage("registry.example/base:latest", true);
    await svc.tagImage("legacy:latest", "sandbox-base:latest");
    await svc.removeImage("sha256:old");

    expect(commands.events()).toEqual([
      {
        command: "docker",
        args: ["pull", "registry.example/base:latest"],
        options: { interactive: true },
      },
      {
        command: "docker",
        args: ["tag", "legacy:latest", "sandbox-base:latest"],
      },
      { command: "docker", args: ["rmi", "sha256:old"] },
    ]);
  });

  // -- Volume operations --------------------------------------------------

  test("volume existence reflects inspect success and failure", async () => {
    const existing = createStatefulRuntimeCommandExecutor();
    existing.givenOutput(
      { command: "docker", args: ["volume", "inspect", "sandbox-cache"] },
      '[{"Name":"sandbox-cache"}]',
    );
    expect(
      await new DockerService(existing.executor).volumeExists("sandbox-cache"),
    ).toBe(true);

    const missing = createStatefulRuntimeCommandExecutor();
    missing.givenFailure(
      { command: "docker", args: ["volume", "inspect", "missing"] },
      new Error("no such volume"),
    );
    expect(
      await new DockerService(missing.executor).volumeExists("missing"),
    ).toBe(false);
  });

  test("create, copy, and remove volume use exact Docker boundaries", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      { command: "docker", args: ["volume", "create", "current"] },
      "",
    );
    commands.givenOutput(
      {
        command: "docker",
        args: [
          "run",
          "--rm",
          "-v",
          "legacy:/from",
          "-v",
          "current:/to",
          "alpine",
          "sh",
          "-c",
          "cp -a /from/. /to/",
        ],
      },
      "",
    );
    commands.givenOutput(
      { command: "docker", args: ["volume", "rm", "legacy"] },
      "",
    );
    const svc = new DockerService(commands.executor);
    await svc.createVolume("current");
    await svc.copyVolume("legacy", "current");
    await svc.removeVolume("legacy");

    expect(commands.events()).toEqual([
      { command: "docker", args: ["volume", "create", "current"] },
      {
        command: "docker",
        args: [
          "run",
          "--rm",
          "-v",
          "legacy:/from",
          "-v",
          "current:/to",
          "alpine",
          "sh",
          "-c",
          "cp -a /from/. /to/",
        ],
      },
      { command: "docker", args: ["volume", "rm", "legacy"] },
    ]);
  });

  test("mutating operations preserve exact runtime failures and exit codes", async () => {
    const cases = [
      {
        args: ["pull", "registry.example/missing:latest"],
        options: { interactive: false },
        run: (svc: DockerService) =>
          svc.pullImage("registry.example/missing:latest"),
      },
      {
        args: ["tag", "missing:latest", "target:latest"],
        run: (svc: DockerService) =>
          svc.tagImage("missing:latest", "target:latest"),
      },
      {
        args: ["rmi", "sha256:in-use"],
        run: (svc: DockerService) => svc.removeImage("sha256:in-use"),
      },
      {
        args: [
          "run",
          "--rm",
          "-v",
          "missing:/from",
          "-v",
          "target:/to",
          "alpine",
          "sh",
          "-c",
          "cp -a /from/. /to/",
        ],
        run: (svc: DockerService) => svc.copyVolume("missing", "target"),
      },
    ];

    for (const [index, operation] of cases.entries()) {
      const commands = createStatefulRuntimeCommandExecutor();
      const failure = new ExecError(
        `Command failed with exit code ${40 + index}`,
        40 + index,
      );
      commands.givenFailure(
        { command: "docker", args: operation.args },
        failure,
      );
      const result = operation.run(new DockerService(commands.executor));

      await expect(result).rejects.toBe(failure);
      expect(failure.exitCode).toBe(40 + index);
      expect(commands.events()).toEqual([
        {
          command: "docker",
          args: operation.args,
          ...(operation.options ? { options: operation.options } : {}),
        },
      ]);
    }
  });

  // -- Runtime-specific flags ---------------------------------------------

  test("getRuntimeRunFlags includes cap-add and sysctl", () => {
    const svc = new DockerService(
      createStatefulRuntimeCommandExecutor().executor,
    );
    const flags = svc.getRuntimeRunFlags();
    expect(flags).toContain("--cap-add=NET_ADMIN");
    expect(flags).toContain("--add-host=host.docker.internal:host-gateway");
    expect(flags.some((f) => f.includes("tcp_tw_reuse"))).toBe(true);
    expect(flags).toContain("--ulimit");
  });

  test("getRuntimeRunFlags includes shmSize when configured", () => {
    const svc = new DockerService(
      createStatefulRuntimeCommandExecutor().executor,
    );
    const flags = svc.getRuntimeRunFlags({ shmSize: "1gb" });
    expect(flags).toContain("--shm-size");
    expect(flags).toContain("1gb");
  });

  test("getBuildEnv returns DOCKER_BUILDKIT", () => {
    const svc = new DockerService(
      createStatefulRuntimeCommandExecutor().executor,
    );
    expect(svc.getBuildEnv()).toEqual({ DOCKER_BUILDKIT: "1" });
  });

  test("getBuildSecretArgs returns --secret format", () => {
    const svc = new DockerService(
      createStatefulRuntimeCommandExecutor().executor,
    );
    expect(svc.getBuildSecretArgs("TOKEN", "TOKEN")).toEqual([
      "--secret",
      "id=TOKEN,env=TOKEN",
    ]);
  });

  test("getHostInternalDns returns host.docker.internal", () => {
    const svc = new DockerService(
      createStatefulRuntimeCommandExecutor().executor,
    );
    expect(svc.getHostInternalDns()).toBe("host.docker.internal");
  });

  // -- Host setup ---------------------------------------------------------

  test("ensureHostSetup returns memory from the daemon check", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      { command: "docker", args: ["info", "--format", "{{.MemTotal}}"] },
      "8345075712\n",
    );
    const svc = new DockerService(commands.executor);
    await expect(svc.ensureHostSetup()).resolves.toEqual({
      memoryBytes: 8345075712,
    });
  });

  test("ensureHostSetup throws when docker info fails", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenFailure(
      { command: "docker", args: ["info", "--format", "{{.MemTotal}}"] },
      new Error("connection refused"),
    );
    const svc = new DockerService(commands.executor);

    await expect(svc.ensureHostSetup()).rejects.toThrow(
      /daemon is not running[\s\S]*Rancher Desktop[\s\S]*Colima/,
    );
  });

  // -- Error messages -----------------------------------------------------

  test("getPruneHint contains docker system prune", () => {
    const svc = new DockerService(
      createStatefulRuntimeCommandExecutor().executor,
    );
    expect(svc.getPruneHint()).toContain("docker system prune");
  });

  test("runtime is docker", () => {
    const svc = new DockerService(
      createStatefulRuntimeCommandExecutor().executor,
    );
    expect(svc.runtime).toBe("docker");
    expect(svc.binaryName).toBe("docker");
  });
});
