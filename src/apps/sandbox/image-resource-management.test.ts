import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SANDBOX_RUNTIME_LABEL } from "#modules/sandbox-runtime/index.js";
import { generateProjectSlug } from "#shared/text/index.js";
import { setupSandboxAppTest } from "./__test__/sandbox-app-test.js";

const PROJECT_LABEL = "sandbox.project";

async function givenLayeredProject(
  app: Awaited<ReturnType<typeof setupSandboxAppTest>>,
): Promise<void> {
  app.global.writeDockerfile("FROM sandbox-base:latest\nRUN echo user\n");
  app.project.writeDockerfile("FROM sandbox-user:latest\nRUN echo project\n");
  await app.project.givenConfig({ allowNetwork: [] });
}

function givenSuccessfulProcessRequests(
  app: Awaited<ReturnType<typeof setupSandboxAppTest>>,
  count: number,
): void {
  for (let request = 0; request < count; request += 1) {
    app.processes
      .expectStart({ match: { command: "podman" } })
      .resolveResult({ exitCode: 0, stdout: "", stderr: "" });
  }
}

describe("sandbox build and upgrade", () => {
  test("builds full, user, and project targets through Commander", async () => {
    await using app = await setupSandboxAppTest({
      variables: { SANDBOX_HOST_UID: "1000", SANDBOX_HOST_GID: "1001" },
    });
    await givenLayeredProject(app);

    const full = await app.cli.run("build");
    expect(full.exitCode).toBe(0);
    expect(full.stderr).toContain("Building sandbox-base:latest");
    expect(full.stderr).toContain("Build complete");
    expect(
      app.runtime.images.builds().map((build) => build.options.tag),
    ).toEqual([
      "sandbox-base:latest",
      "sandbox-user:latest",
      `sandbox-${generateProjectSlug(app.project.root)}:latest`,
    ]);
    expect(app.runtime.images.builds()[0]?.options.buildArgs).toMatchObject({
      HOST_UID: "1000",
      HOST_GID: "1001",
    });

    const beforeUser = app.runtime.images.builds().length;
    const user = await app.cli.run("build", "--user");
    expect(user.exitCode).toBe(0);
    expect(app.runtime.images.builds()).toHaveLength(beforeUser);

    const beforeProject = app.runtime.images.builds().length;
    const project = await app.cli.run("build", "--project");
    expect(project.exitCode).toBe(0);
    expect(app.runtime.images.builds()).toHaveLength(beforeProject);
  });

  test("rejects conflicting targets without resolving a runtime", async () => {
    await using app = await setupSandboxAppTest();
    const result = await app.cli.run("build", "--user", "--project");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Cannot specify both --user and --project flags",
    );
    expect(app.runtime.resolvedConfigurations()).toEqual([]);
  });

  test("uses cache for build and no cache for explicit and upgrade rebuilds", async () => {
    await using app = await setupSandboxAppTest();
    await givenLayeredProject(app);

    expect((await app.cli.run("build")).exitCode).toBe(0);
    const initialBuilds = app.runtime.images.builds();
    expect(
      initialBuilds.every((build) => build.options.noCache === false),
    ).toBe(true);

    expect((await app.cli.run("build", "--no-cache")).exitCode).toBe(0);
    const noCacheBuilds = app.runtime.images
      .builds()
      .slice(initialBuilds.length);
    expect(noCacheBuilds).toHaveLength(3);
    expect(noCacheBuilds.every((build) => build.options.noCache)).toBe(true);

    const beforeUpgrade = app.runtime.images.builds().length;
    const upgrade = await app.cli.run("upgrade", "--project");
    expect(upgrade.stderr).toContain("fresh packages");
    expect(
      app.runtime.images
        .builds()
        .slice(beforeUpgrade)
        .every((build) => build.options.noCache),
    ).toBe(true);
  });

  test("records build streams and preserves build failure exit codes", async () => {
    await using success = await setupSandboxAppTest();
    success.runtime.images.givenNextBuild({
      stdout: ["#1 loading build definition"],
      stderr: ["warning from builder"],
    });
    expect((await success.cli.run("build")).exitCode).toBe(0);
    expect(success.runtime.images.builds()[0]).toMatchObject({
      stdout: ["#1 loading build definition"],
      stderr: ["warning from builder"],
    });

    await using failure = await setupSandboxAppTest();
    failure.runtime.images.givenNextBuild({
      error: Object.assign(new Error("builder failed"), { exitCode: 73 }),
      stderr: ["builder failed"],
    });
    const result = await failure.cli.run("build");
    expect(result.exitCode).toBe(73);
    expect(result.stderr).toContain(
      "Failed to build sandbox-base:latest\nbuilder failed",
    );
  });

  test("honors configured runtime selection", async () => {
    await using app = await setupSandboxAppTest({ runtime: "podman" });
    app.global.writeConfig('runtime = "podman"\n');

    expect((await app.cli.run("build")).exitCode).toBe(0);
    expect(app.runtime.resolvedConfigurations()).toEqual(["podman"]);
  });

  test("uses only harness-owned Podman secrets and redacts command output", async () => {
    await using configured = await setupSandboxAppTest({
      variables: { GITHUB_TOKEN: "harness-secret" },
      runtime: "podman",
      runtimeBoundary: "process",
    });
    configured.global.writeConfig('runtime = "podman"\n');
    givenSuccessfulProcessRequests(configured, 3);

    const configuredResult = await configured.cli.run("--verbose", "build");
    const configuredBuilds = configured.processes.requests.filter(
      (request) =>
        request.command === "podman" && request.args?.[0] === "build",
    );
    expect(configuredResult.exitCode).toBe(0);
    expect(
      configuredBuilds.some((request) =>
        request.args?.includes("GITHUB_TOKEN=harness-secret"),
      ),
    ).toBe(true);
    expect(configuredResult.stderr).toContain("GITHUB_TOKEN=<redacted>");
    expect(configuredResult.stderr).not.toContain("harness-secret");

    await using absent = await setupSandboxAppTest({
      runtime: "podman",
      runtimeBoundary: "process",
    });
    absent.global.writeConfig('runtime = "podman"\n');
    givenSuccessfulProcessRequests(absent, 3);

    const absentResult = await absent.cli.run("--verbose", "build");
    const absentBuildArgs = absent.processes.requests
      .filter(
        (request) =>
          request.command === "podman" && request.args?.[0] === "build",
      )
      .flatMap((request) => request.args ?? []);
    expect(absentResult.exitCode).toBe(0);
    expect(absentBuildArgs.some((arg) => arg.startsWith("GITHUB_TOKEN="))).toBe(
      false,
    );
    expect(absentResult.stdout).not.toContain("harness-secret");
    expect(absentResult.stderr).not.toContain("harness-secret");
  });
});

describe("sandbox migrate", () => {
  test("reports no legacy resources and remains idempotent", async () => {
    await using app = await setupSandboxAppTest();

    const first = await app.cli.run("migrate");
    const second = await app.cli.run("migrate");
    expect(first.stderr).toContain(
      "Nothing to migrate - all resources use the new naming",
    );
    expect(second.exitCode).toBe(0);
    expect(app.runtime.images.all()).toEqual([]);
    expect(app.runtime.volumes.all()).toEqual([]);
  });

  test("migrates eligible images, containers, volumes, and Dockerfiles", async () => {
    await using app = await setupSandboxAppTest();
    app.project.writeDockerfile("FROM sandbox--base:latest\n");
    await app.project.givenConfig({ allowNetwork: [] });
    app.runtime.images.create({
      id: "sha256:legacy",
      references: ["sandbox--base:latest"],
      labels: { generation: "legacy" },
    });
    app.runtime.volumes.create({
      name: "sandbox--cache",
      files: { "cache/value": "preserved" },
    });
    const container = app.runtime.containers.create({
      name: "sandbox--legacy-project",
      image: "sandbox--base:latest",
      labels: { [PROJECT_LABEL]: "legacy-project" },
      status: "exited",
    });

    const result = await app.cli.run("migrate");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Retagged 1 image(s)");
    expect(result.stderr).toContain("Migrated cache volume");
    expect(result.stderr).toContain("Removed 1 legacy container(s)");
    expect(app.runtime.images.find("sandbox-base:latest")?.id).toBe(
      "sha256:legacy",
    );
    expect(app.runtime.images.find("sandbox--base:latest")).toBeUndefined();
    expect(app.runtime.volumes.find("sandbox-cache")?.files).toEqual({
      "cache/value": "preserved",
    });
    expect(app.runtime.volumes.find("sandbox--cache")).toBeUndefined();
    expect(container.snapshot().status).toBe("removed");
  });

  test("protects active resources through runtime conflicts and continues partial migration", async () => {
    await using app = await setupSandboxAppTest();
    app.runtime.images.create({ references: ["sandbox--base:latest"] });
    app.runtime.images.create({ references: ["sandbox-base:latest"] });
    app.runtime.volumes.create({ name: "sandbox--cache" });
    app.runtime.volumes.create({ name: "sandbox-cache" });
    app.runtime.system.fail("volume.remove", new Error("volume is in use"));
    app.runtime.system.fail(
      "container.remove",
      new Error("container is active"),
    );
    const active = app.runtime.containers.create({
      name: "sandbox--active",
      image: "sandbox--base:latest",
      labels: { [PROJECT_LABEL]: "active" },
      status: "running",
    });

    const result = await app.cli.run("migrate");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Failed to retag");
    expect(result.stderr).toContain("Could not remove legacy volume");
    expect(result.stderr).toContain("Failed to remove container");
    expect(app.runtime.images.find("sandbox--base:latest")).toBeDefined();
    expect(app.runtime.volumes.find("sandbox--cache")).toBeDefined();
    expect(active.snapshot().status).toBe("running");
  });

  test("contains runtime collection failures as an empty migration", async () => {
    await using app = await setupSandboxAppTest();
    app.runtime.system.fail(
      "image.references.list",
      new Error("runtime unavailable"),
    );
    app.runtime.system.fail("volume.exists", new Error("runtime unavailable"));

    const result = await app.cli.run("migrate");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("runtime unavailable");
  });
});

describe("sandbox clean", () => {
  test("removes old unreferenced runtime caches", async () => {
    await using app = await setupSandboxAppTest();
    const old = new Date(Date.UTC(2025, 11, 29));
    const referenced = `1.69.0-${"a".repeat(64)}`;
    const unused = `1.68.0-${"b".repeat(64)}`;
    for (const id of [referenced, unused]) {
      const directory = path.join(
        app.workspace.dataRoot,
        "sandbox",
        "runtime",
        id,
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "runtime.js"), id);
      utimesSync(directory, old, old);
    }
    app.runtime.containers.create({
      name: "runtime-consumer",
      image: "sandbox-project:latest",
      labels: {
        [PROJECT_LABEL]: "project",
        [SANDBOX_RUNTIME_LABEL]: referenced,
      },
      status: "running",
    });

    expect((await app.cli.run("clean", "--force")).exitCode).toBe(0);
    expect(
      app.workspace.dataFileExists(`sandbox/runtime/${referenced}/runtime.js`),
    ).toBe(true);
    expect(
      app.workspace.dataFileExists(`sandbox/runtime/${unused}/runtime.js`),
    ).toBe(false);
  });

  test("handles no resources and removes stopped Sandbox containers from all projects", async () => {
    await using empty = await setupSandboxAppTest();
    const noResources = await empty.cli.run("clean", "--force");
    expect(noResources.exitCode).toBe(0);
    expect(noResources.stderr).toContain("No containers to remove");
    expect(noResources.stderr).toContain("No dangling images to clean");

    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const current = generateProjectSlug(app.project.root);
    const stopped = app.runtime.containers.create({
      name: "stopped",
      image: `sandbox-${current}:latest`,
      labels: { [PROJECT_LABEL]: current },
      status: "exited",
    });
    const running = app.runtime.containers.create({
      name: "running",
      image: `sandbox-${current}:latest`,
      labels: { [PROJECT_LABEL]: current },
      status: "running",
    });
    const other = app.runtime.containers.create({
      name: "other",
      image: "sandbox-other:latest",
      labels: { [PROJECT_LABEL]: "other" },
      status: "exited",
    });

    expect((await app.cli.run("clean", "--force")).exitCode).toBe(0);
    expect(stopped.snapshot().status).toBe("removed");
    expect(running.snapshot().status).toBe("running");
    expect(other.snapshot().status).toBe("removed");
  });

  test("--all removes running containers and unused dangling images", async () => {
    await using app = await setupSandboxAppTest();
    const running = app.runtime.containers.create({
      name: "running",
      image: "sandbox-project:latest",
      labels: { [PROJECT_LABEL]: "project" },
      status: "running",
    });
    app.runtime.images.create({
      id: "sha256:dangling",
      dangling: true,
      size: 1_500_000,
      created: "today",
    });

    const result = await app.cli.run("clean", "--all", "--force");
    expect(result.exitCode).toBe(0);
    expect(running.snapshot().status).toBe("removed");
    expect(app.runtime.images.find("sha256:dangling")).toBeUndefined();
    expect(result.stderr).toContain("Removed 1 dangling images");
    expect(result.stderr).toContain("Freed: 1.5MB");
  });

  test("keeps dangling images used by active containers", async () => {
    await using app = await setupSandboxAppTest();
    app.runtime.images.create({ id: "sha256:used", dangling: true });
    app.runtime.containers.create({
      name: "consumer",
      image: "sha256:used",
      labels: {},
      status: "running",
    });

    expect((await app.cli.run("clean", "--force")).exitCode).toBe(0);
    expect(app.runtime.images.find("sha256:used")).toBeDefined();
  });

  test("accepts or rejects data deletion confirmation", async () => {
    await using accepted = await setupSandboxAppTest();
    accepted.global.writeConfig(
      'persist_paths = [{ path = "/work", use_named_volume = "work" }]\n',
    );
    await accepted.project.givenConfig({ allowNetwork: [] });
    accepted.runtime.volumes.create({ name: "sandbox-cache" });
    accepted.runtime.volumes.create({ name: "sandbox-work" });
    accepted.project.givenPersistentData({ "state.txt": "state" });
    const acceptedExecution = accepted.cli.run("clean", "--data");
    await accepted.tui.waitForText("This will delete all sandbox containers");
    await accepted.tui.user.type("y");
    expect((await acceptedExecution).exitCode).toBe(0);
    expect(accepted.runtime.volumes.find("sandbox-cache")).toBeUndefined();
    expect(accepted.runtime.volumes.find("sandbox-work")).toBeUndefined();
    expect(accepted.project.persistentDataExists()).toBe(false);

    await using rejected = await setupSandboxAppTest();
    await rejected.project.givenConfig({ allowNetwork: [] });
    rejected.runtime.volumes.create({ name: "sandbox-cache" });
    rejected.runtime.images.create({
      id: "sha256:dangling",
      dangling: true,
    });
    rejected.project.givenPersistentData({ "state.txt": "state" });
    const rejectedExecution = rejected.cli.run("clean", "--data");
    await rejected.tui.waitForText("This will delete all sandbox containers");
    await rejected.tui.user.enter();
    const rejectedResult = await rejectedExecution;
    expect(rejectedResult.stderr).toContain("Cancelled");
    expect(rejected.runtime.volumes.find("sandbox-cache")).toBeDefined();
    expect(rejected.runtime.images.find("sha256:dangling")).toBeDefined();
    expect(rejected.project.persistentDataExists()).toBe(true);
  });

  test("returns cancellation and contains partial cleanup failures", async () => {
    await using cancelled = await setupSandboxAppTest();
    const cancellation = cancelled.cli.run("clean", "--data");
    await cancelled.tui.waitForText("This will delete all sandbox containers");
    cancelled.tui.cancel();
    expect((await cancellation).exitCode).toBe(1);

    await using partial = await setupSandboxAppTest();
    partial.runtime.containers.create({
      name: "first",
      image: "sandbox-first:latest",
      labels: { [PROJECT_LABEL]: "first" },
      status: "running",
    });
    const second = partial.runtime.containers.create({
      name: "second",
      image: "sandbox-second:latest",
      labels: { [PROJECT_LABEL]: "second" },
      status: "running",
    });
    partial.runtime.system.fail("container.remove", new Error("remove denied"));
    const result = await partial.cli.run("clean", "--all", "--force");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Failed to remove container");
    expect(second.snapshot().status).toBe("removed");
  });
});
