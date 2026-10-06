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

function givenSuccessfulPodmanBuild(
  app: Awaited<ReturnType<typeof setupSandboxAppTest>>,
): void {
  const missing = { exitCode: 1, stdout: "", stderr: "No such image" };
  const inspection = {
    exitCode: 0,
    stdout: JSON.stringify([
      {
        Id: "sha256:built",
        RepoTags: null,
        Size: 0,
        Config: { Labels: { "sandbox.managed": "true" } },
      },
    ]),
    stderr: "",
  };
  for (let build = 0; build < 3; build += 1) {
    app.processes
      .expectStart({ match: { command: "podman" } })
      .resolveResult(missing);
    app.processes
      .expectStart({ match: { command: "podman" } })
      .resolveResult({ exitCode: 0, stdout: "", stderr: "" });
    app.processes
      .expectStart({ match: { command: "podman" } })
      .resolveResult(inspection);
  }
  app.processes
    .expectStart({ match: { command: "podman" } })
    .resolveResult({ exitCode: 0, stdout: "", stderr: "" });
  app.processes
    .expectStart({ match: { command: "podman" } })
    .resolveResult(inspection);
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
    expect(
      app.runtime.images.builds().map((build) => build.options.tag),
    ).toEqual([
      "sandbox-base:latest",
      "sandbox-user:latest",
      `sandbox-${generateProjectSlug(app.project.root)}:latest`,
    ]);
    expect(
      app.runtime.images.builds()[0]?.options.buildArguments,
    ).toMatchObject({
      HOST_UID: "1000",
      HOST_GID: "1001",
    });
    expect(
      app.runtime.images
        .builds()
        .every((build) => build.options.labels["sandbox.managed"] === "true"),
    ).toBe(true);

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
      initialBuilds.every((build) => build.options.cachePolicy === "use"),
    ).toBe(true);

    expect((await app.cli.run("build", "--no-cache")).exitCode).toBe(0);
    const noCacheBuilds = app.runtime.images
      .builds()
      .slice(initialBuilds.length);
    expect(noCacheBuilds).toHaveLength(3);
    expect(
      noCacheBuilds.every((build) => build.options.cachePolicy === "bypass"),
    ).toBe(true);

    const beforeUpgrade = app.runtime.images.builds().length;
    const upgrade = await app.cli.run("upgrade", "--project");
    expect(upgrade.stderr).toContain("fresh packages");
    expect(
      app.runtime.images
        .builds()
        .slice(beforeUpgrade)
        .every((build) => build.options.cachePolicy === "bypass"),
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

  test.each(["podman", "apple-container"] as const)(
    "honors configured %s runtime selection without fallback",
    async (runtime) => {
      await using app = await setupSandboxAppTest({ runtime });
      app.global.writeConfig(`runtime = "${runtime}"\n`);

      expect((await app.cli.run("build")).exitCode).toBe(0);
      expect(app.runtime.resolvedConfigurations()).toEqual([runtime]);
    },
  );

  test("uses only harness-owned Podman secrets and redacts command output", async () => {
    await using configured = await setupSandboxAppTest({
      variables: { GITHUB_TOKEN: "harness-secret" },
      runtime: "podman",
      runtimeBoundary: "process",
    });
    configured.global.writeConfig('runtime = "podman"\n');
    givenSuccessfulPodmanBuild(configured);

    const configuredResult = await configured.cli.run("--verbose", "build");
    const configuredBuilds = configured.processes.requests.filter(
      (request) =>
        request.command === "podman" && request.args?.[0] === "build",
    );
    expect(configuredResult.exitCode).toBe(0);
    expect(
      configuredBuilds.some((request) =>
        request.args?.includes("id=GITHUB_TOKEN,env=GITHUB_TOKEN"),
      ),
    ).toBe(true);
    expect(configuredResult.stderr).toContain(
      "id=GITHUB_TOKEN,env=GITHUB_TOKEN",
    );
    expect(configuredResult.stderr).not.toContain("harness-secret");
    expect(
      configuredBuilds
        .flatMap((request) => request.args ?? [])
        .some((arg) => arg.startsWith("GITHUB_TOKEN=")),
    ).toBe(false);

    await using absent = await setupSandboxAppTest({
      runtime: "podman",
      runtimeBoundary: "process",
    });
    absent.global.writeConfig('runtime = "podman"\n');
    givenSuccessfulPodmanBuild(absent);

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

test("rejects the removed migration command without accessing runtime resources", async () => {
  await using app = await setupSandboxAppTest();

  const result = await app.cli.run("migrate");

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("unknown command 'migrate'");
  expect(app.runtime.resolvedConfigurations()).toEqual([]);
  expect(app.runtime.events()).toEqual([]);
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
    app.runtime.instances.create({
      name: "runtime-consumer",
      image: "sandbox-project:latest",
      labels: {
        [PROJECT_LABEL]: "project",
        [SANDBOX_RUNTIME_LABEL]: referenced,
      },
      status: "running",
    });

    const cleanResult = await app.cli.run("clean", "--force");
    expect(cleanResult.exitCode, cleanResult.stderr).toBe(0);
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
    expect(noResources.stderr).toContain("No unused managed images to clean");

    await using app = await setupSandboxAppTest();
    await app.project.givenConfig({ allowNetwork: [] });
    const current = generateProjectSlug(app.project.root);
    const stopped = app.runtime.instances.create({
      name: "stopped",
      image: `sandbox-${current}:latest`,
      labels: { [PROJECT_LABEL]: current },
      status: "exited",
    });
    const running = app.runtime.instances.create({
      name: "running",
      image: `sandbox-${current}:latest`,
      labels: { [PROJECT_LABEL]: current },
      status: "running",
    });
    const other = app.runtime.instances.create({
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

  test("--all removes running instances without pruning untracked images", async () => {
    await using app = await setupSandboxAppTest();
    const running = app.runtime.instances.create({
      name: "running",
      image: "sandbox-project:latest",
      labels: { [PROJECT_LABEL]: "project" },
      status: "running",
    });
    app.runtime.images.create({
      id: "sha256:dangling",
      labels: { "sandbox.managed": "true" },
      dangling: true,
      size: 1_500_000,
      created: "today",
    });

    const result = await app.cli.run("clean", "--all", "--force");
    expect(result.exitCode).toBe(0);
    expect(running.snapshot().status).toBe("removed");
    expect(app.runtime.images.find("sha256:dangling")).toBeDefined();
    expect(result.stderr).toContain("No unused managed images to clean");
  });

  test("keeps dangling images used by active containers", async () => {
    await using app = await setupSandboxAppTest();
    app.runtime.images.create({
      id: "sha256:used",
      labels: { "sandbox.managed": "true" },
      dangling: true,
    });
    app.runtime.instances.create({
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
    accepted.runtime.storage.create({ name: "sandbox-cache" });
    accepted.runtime.storage.create({ name: "sandbox-work" });
    accepted.project.givenPersistentData({ "state.txt": "state" });
    const acceptedExecution = accepted.cli.run("clean", "--data");
    await accepted.tui.waitForText("This will delete all sandbox containers");
    await accepted.tui.user.type("y");
    expect((await acceptedExecution).exitCode).toBe(0);
    expect(accepted.runtime.storage.find("sandbox-cache")).toBeUndefined();
    expect(accepted.runtime.storage.find("sandbox-work")).toBeUndefined();
    expect(accepted.project.persistentDataExists()).toBe(false);

    await using rejected = await setupSandboxAppTest();
    await rejected.project.givenConfig({ allowNetwork: [] });
    rejected.runtime.storage.create({ name: "sandbox-cache" });
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
    expect(rejected.runtime.storage.find("sandbox-cache")).toBeDefined();
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
    partial.runtime.instances.create({
      name: "first",
      image: "sandbox-first:latest",
      labels: { [PROJECT_LABEL]: "first" },
      status: "running",
    });
    const second = partial.runtime.instances.create({
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
