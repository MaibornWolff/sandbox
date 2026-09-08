import { describe, expect, test } from "bun:test";
import { createStatefulContainerRuntimeHarness } from "./index.js";

describe("stateful container runtime harness", () => {
  test("starts empty and records container list operations", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    const runtime = await harness.provider.resolve("docker");

    expect(
      await runtime.listContainers({
        labelFilter: "sandbox.project=isolated-project",
        statusFilter: ["running"],
      }),
    ).toEqual([]);
    expect(harness.events()).toEqual([
      {
        type: "container.list",
        options: {
          labelFilter: "sandbox.project=isolated-project",
          statusFilter: ["running"],
        },
      },
    ]);
  });

  test("filters managed containers by running state, status, and labels", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.containers.create({
      name: "running-match",
      image: "sandbox-project:latest",
      labels: { "sandbox.project": "project-a" },
      status: "running",
    });
    harness.containers.create({
      name: "exited-match",
      image: "sandbox-project:latest",
      labels: { "sandbox.project": "project-a" },
      status: "exited",
    });
    harness.containers.create({
      name: "other-project",
      image: "sandbox-project:latest",
      labels: { "sandbox.project": "project-b" },
      status: "running",
    });
    const runtime = await harness.provider.resolve();

    expect(
      (await runtime.listContainers()).map((container) => container.name),
    ).toEqual(["running-match", "other-project"]);
    expect(
      (
        await runtime.listContainers({
          all: true,
          labelFilter: "sandbox.project=project-a",
          statusFilter: ["exited"],
        })
      ).map((container) => container.name),
    ).toEqual(["exited-match"]);
    expect(
      (
        await runtime.listContainers({
          all: true,
          labelFilter: "sandbox.project",
        })
      ).map((container) => container.name),
    ).toEqual(["running-match", "exited-match", "other-project"]);
  });

  test("executes deterministic fixtures and records ordered events", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    const container = harness.containers.create({
      name: "managed",
      image: "sandbox-project:latest",
      labels: {},
      status: "running",
    });
    container.givenExecResult(["cat", "/tmp/result"], "fixture output");
    const runtime = await harness.provider.resolve();

    await runtime.listContainers();
    expect(
      await runtime.execInContainer(container.id, ["cat", "/tmp/result"], {
        user: "root",
      }),
    ).toBe("fixture output");
    await runtime.signalContainer(container.id, "SIGTERM");
    expect(container.snapshot().status).toBe("exited");
    await runtime.removeContainer(container.id, true);

    expect(harness.events()).toEqual([
      { type: "container.list", options: {} },
      {
        type: "container.exec",
        containerId: container.id,
        command: ["cat", "/tmp/result"],
        options: { user: "root" },
      },
      {
        type: "container.signal",
        containerId: container.id,
        signal: "SIGTERM",
      },
      { type: "container.remove", containerId: container.id, force: true },
    ]);
    expect(container.snapshot().status).toBe("removed");
  });

  test("models image builds, tags, parents, inspect state, and ordered events", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.images.create({
      id: "sha256:parent",
      references: ["sandbox-base:latest"],
      labels: { "dockerfile.hash": "aaaaaaaaaaaa" },
      inspectData: { architecture: "amd64" },
    });
    harness.images.givenNextBuild({
      id: "sha256:child",
      parentId: "sha256:parent",
      stdout: ["step 1"],
      stderr: ["warning"],
    });
    const runtime = await harness.provider.resolve();

    await runtime.buildImage({
      tag: "sandbox-user:latest",
      dockerfilePath: "/build/Dockerfile",
      contextDir: "/build",
      labels: { "dockerfile.hash": "bbbbbbbbbbbb" },
      noCache: true,
    });
    await runtime.tagImage("sandbox-user:latest", "sandbox-user:stable");

    expect(harness.images.find("sandbox-user:stable")).toMatchObject({
      id: "sha256:child",
      parentId: "sha256:parent",
      dangling: false,
      labels: { "dockerfile.hash": "bbbbbbbbbbbb" },
    });
    expect(harness.images.find("sha256:parent")?.inspectData).toEqual({
      architecture: "amd64",
    });
    expect(harness.images.builds()).toMatchObject([
      { imageId: "sha256:child", stdout: ["step 1"], stderr: ["warning"] },
    ]);
    expect(harness.events().map((event) => event.type)).toEqual([
      "image.build",
      "image.tag",
    ]);
  });

  test("models dangling filtering, image users, removal failures, and final state", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.images.create({
      id: "sha256:dangling",
      dangling: true,
      size: 4_096,
      created: "yesterday",
    });
    harness.containers.create({
      name: "consumer",
      image: "sha256:dangling",
      labels: {},
      status: "running",
    });
    const runtime = await harness.provider.resolve();

    expect(await runtime.listDanglingImages("sandbox-*")).toEqual([
      { id: "sha256:dangling", size: 4_096, created: "yesterday" },
    ]);
    expect(await runtime.getContainersUsingImage("sha256:dangling")).toEqual([
      "container-1",
    ]);
    harness.system.fail("image.remove", new Error("in use"));
    await expect(runtime.removeImage("sha256:dangling")).rejects.toThrow(
      "in use",
    );
    expect(harness.images.find("sha256:dangling")).toBeDefined();
  });

  test("copies volume state and records create, copy, and removal order", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.volumes.create({
      name: "legacy",
      files: { "nested/file": "content" },
    });
    const runtime = await harness.provider.resolve();

    expect(await runtime.volumeExists("legacy")).toBe(true);
    await runtime.createVolume("current");
    await runtime.copyVolume("legacy", "current");
    await runtime.removeVolume("legacy");

    expect(harness.volumes.find("current")?.files).toEqual({
      "nested/file": "content",
    });
    expect(harness.volumes.find("legacy")).toBeUndefined();
    expect(harness.events().map((event) => event.type)).toEqual([
      "volume.exists",
      "volume.create",
      "volume.copy",
      "volume.remove",
    ]);
  });

  test("implements runtime metadata, pull, setup, and inspect operations explicitly", async () => {
    const harness = createStatefulContainerRuntimeHarness({
      runtime: "podman",
    });
    harness.system.givenVersion("podman version fixture");
    harness.system.givenMemoryBytes(4_096);
    const container = harness.containers.create({
      name: "managed",
      image: "registry.example/base:latest",
      labels: { purpose: "contract" },
      status: "running",
      uptime: "5 minutes",
    });
    const runtime = await harness.provider.resolve("podman");

    expect(runtime.runtime).toBe("podman");
    expect(runtime.binaryName).toBe("podman");
    expect(await runtime.getVersion()).toBe("podman version fixture");
    expect(await runtime.getMemoryBytes()).toBe(4_096);
    expect(await runtime.getContainerState(container.id)).toBe("running");
    expect(await runtime.getContainerLabel(container.id, "purpose")).toBe(
      "contract",
    );
    expect(await runtime.getContainerUptime(container.id)).toBe("5 minutes");

    await runtime.pullImage("registry.example/base:latest", true);
    expect(harness.images.find("registry.example/base:latest")).toBeDefined();
    expect(runtime.getRuntimeRunFlags({ shmSize: "1gb" })).toContain(
      "nofile=65535:65535",
    );
    expect(runtime.getBuildEnv()).toEqual({});
    expect(runtime.getBuildSecretArgs("TOKEN", "TOKEN_ENV")).toEqual([
      "--build-arg",
      "TOKEN=$TOKEN",
    ]);
    expect(runtime.getHostInternalDns()).toBe("host.containers.internal");
    await expect(runtime.ensureHostSetup()).resolves.toEqual({
      memoryBytes: 4_096,
    });
    expect(runtime.getPruneHint()).toContain("podman system prune");
    expect(runtime.getInstallHint()).toContain("Install Podman");

    expect(harness.events().map((event) => event.type)).toEqual([
      "system.version",
      "system.memory",
      "container.state",
      "container.label",
      "container.uptime",
      "image.pull",
      "runtime.run-flags",
      "runtime.build-env",
      "runtime.build-secret-args",
      "host.internal-dns",
      "host.setup",
      "hint.prune",
      "hint.install",
    ]);
  });

  test("models explicit pull and durable host setup failures", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    const runtime = await harness.provider.resolve();

    harness.system.fail("image.pull", new Error("registry unavailable"));
    await expect(
      runtime.pullImage("registry.example/missing:latest"),
    ).rejects.toThrow("registry unavailable");
    expect(
      harness.images.find("registry.example/missing:latest"),
    ).toBeUndefined();

    harness.system.givenHostSetupFailure(new Error("daemon unavailable"));
    await expect(runtime.ensureHostSetup()).rejects.toThrow(
      "daemon unavailable",
    );
    await expect(runtime.ensureHostSetup()).rejects.toThrow(
      "daemon unavailable",
    );
    harness.system.givenHostSetupReady();
    await expect(runtime.ensureHostSetup()).resolves.toEqual({
      memoryBytes: 8 * 1024 ** 3,
    });
  });

  test("fails clearly for missing resources and exec fixtures", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    const container = harness.containers.create({
      name: "managed",
      image: "sandbox-project:latest",
      labels: {},
      status: "running",
    });
    const runtime = await harness.provider.resolve();

    await expect(runtime.getContainerState("missing")).rejects.toThrow(
      'Container "missing" does not exist.',
    );
    await expect(
      runtime.execInContainer(container.id, ["missing", "fixture"]),
    ).rejects.toThrow("No exec result configured");
  });
});
