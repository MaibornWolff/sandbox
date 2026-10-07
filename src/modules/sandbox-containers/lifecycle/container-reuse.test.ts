import { describe, expect, test } from "bun:test";
import { createTestClock } from "#platform/clock/__test__/index.js";
import type { Clock } from "#platform/clock/index.js";
import { provideClock } from "#platform/clock/index.js";
import { createStatefulContainerRuntimeHarness } from "#platform/container-runtime/__test__/index.js";
import {
  SandboxInstanceNameConflictError,
  type SandboxInstanceSpec,
} from "#platform/container-runtime/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import {
  createFreshContainer,
  findOrCreateContainer,
} from "./container-reuse.js";
import { prepareContainerSession } from "./container-session.js";

function createSpec(): SandboxInstanceSpec {
  return {
    name: "",
    image: { reference: "sha256:image", digest: "sha256:image" },
    labels: { "sandbox.project": "project" },
    environment: { SANDBOX: "1" },
    mounts: [],
    ports: [],
    init: true,
    removeOnExit: true,
    resources: {},
    security: { capabilities: ["NET_ADMIN"], nestedContainerRuntime: false },
  };
}

async function startingContainerFixture() {
  const harness = createStatefulContainerRuntimeHarness();
  const container = harness.instances.create({
    name: "sandbox-project",
    image: "sandbox-project:latest",
    labels: { "sandbox.project": "project", "sandbox.hash": "expected" },
    status: "created",
  });
  const { runtime } = await harness.provider.resolve();
  const clock = createTestClock();
  return {
    harness,
    container,
    clock,
    reuse: () =>
      findOrCreateContainer(runtime, "project", "expected", createSpec()),
    async run(test: () => Promise<void>) {
      await using resources = new AsyncDisposableStack();
      resources.defer(() => clock.dispose());
      await runWithTestLogger(() =>
        runWithDependencies([provideClock(clock.clock)], test),
      );
    },
  };
}

describe("container reuse", () => {
  test.each(["reuse", "fresh"])(
    "uses one safe snapshot for %s creation",
    async (mode) => {
      const harness = createStatefulContainerRuntimeHarness();
      for (const status of ["exited", "dead", "paused", "created"] as const) {
        harness.instances.create({
          name: `sandbox-project-${status}`,
          image: "sandbox-project:latest",
          labels: { "sandbox.project": "project" },
          status,
        });
      }
      const runtime = (await harness.provider.resolve()).runtime;
      await runWithTestLogger(() =>
        mode === "reuse"
          ? findOrCreateContainer(runtime, "project", "expected", createSpec())
          : createFreshContainer(runtime, "project", createSpec()),
      );
      expect(
        harness.events().filter((event) => event.type === "container.list"),
      ).toHaveLength(1);
      expect(harness.instances.find("sandbox-project-exited")).toBeUndefined();
      expect(harness.instances.find("sandbox-project-dead")).toBeUndefined();
      expect(harness.instances.find("sandbox-project-paused")?.status).toBe(
        "paused",
      );
      expect(harness.instances.find("sandbox-project-created")?.status).toBe(
        "created",
      );
    },
  );

  test("does not create or remove containers when the snapshot fails", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.system.fail("container.list", new Error("snapshot unavailable"));
    const runtime = (await harness.provider.resolve()).runtime;
    await expect(
      runWithTestLogger(() =>
        findOrCreateContainer(runtime, "project", "expected", createSpec()),
      ),
    ).rejects.toThrow("snapshot unavailable");
    expect(
      harness
        .events()
        .filter(
          (event) =>
            event.type === "container.create" ||
            event.type === "container.remove",
        ),
    ).toHaveLength(0);
  });
  test("does not delete another caller's instance before it starts", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.instances.create({
      name: "sandbox-project",
      image: "sandbox-project:latest",
      labels: { "sandbox.project": "project", "sandbox.hash": "expected" },
      status: "created",
    });
    const runtime = (await harness.provider.resolve()).runtime;
    await runWithTestLogger(() =>
      createFreshContainer(runtime, "project", createSpec()),
    );
    expect(harness.instances.find("sandbox-project")?.status).toBe("created");
  });

  test("reuses a running container with the same hash", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.instances.create({
      name: "sandbox-project",
      image: "sandbox-project:latest",
      labels: { "sandbox.project": "project", "sandbox.hash": "expected" },
      status: "running",
    });
    const runtime = (await harness.provider.resolve()).runtime;
    const result = await runWithTestLogger(() =>
      findOrCreateContainer(runtime, "project", "expected", createSpec()),
    );
    expect(result).toEqual({
      containerName: "sandbox-project",
      created: false,
    });
    expect(harness.instances.all()).toHaveLength(1);
  });

  test("waits for another caller to start the matching container", async () => {
    const fixture = await startingContainerFixture();
    await fixture.run(async () => {
      const preparation = fixture.reuse();
      expect(
        await Promise.race([
          preparation.then(() => "completed"),
          fixture.clock.waitForSleep().then(() => "waiting"),
        ]),
      ).toBe("waiting");
      fixture.container.givenStatus("running");
      await fixture.clock.advanceBy(50);
      expect(await preparation).toEqual({
        containerName: "sandbox-project",
        created: true,
      });
      expect(fixture.harness.instances.all()).toHaveLength(1);
    });
  });

  test("replaces a container that fails during startup", async () => {
    const fixture = await startingContainerFixture();
    await fixture.run(async () => {
      const preparation = fixture.reuse();
      await fixture.clock.waitForSleep();
      fixture.container.givenStatus("exited");
      await fixture.clock.advanceBy(50);
      expect(await preparation).toEqual({
        containerName: "sandbox-project",
        created: true,
      });
      expect(fixture.container.snapshot().status).toBe("removed");
      expect(
        fixture.harness.instances
          .all()
          .filter((instance) => instance.status !== "removed"),
      ).toHaveLength(1);
    });
  });

  test("times out without removing another caller's starting container", async () => {
    const fixture = await startingContainerFixture();
    await fixture.run(async () => {
      const failure = fixture.reuse().catch((error: unknown) => error);
      await fixture.clock.waitForSleep();
      await fixture.clock.advanceBy(30_000);
      expect(await failure).toMatchObject({
        message: expect.stringContaining("did not finish starting"),
      });
      expect(fixture.container.snapshot().status).toBe("created");
      expect(fixture.harness.instances.all()).toHaveLength(1);
    });
  });

  test("removes an idle obsolete container before replacement", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.instances.create({
      name: "sandbox-project",
      image: "sandbox-project:latest",
      labels: { "sandbox.project": "project", "sandbox.hash": "old" },
      status: "running",
    });
    const runtime = (await harness.provider.resolve()).runtime;
    const result = await runWithTestLogger(() =>
      findOrCreateContainer(runtime, "project", "new", createSpec()),
    );
    expect(result.created).toBe(true);
    expect(
      harness.instances.all().filter((entry) => entry.status === "running"),
    ).toHaveLength(1);
  });

  test("waits for a concurrently created container to become visible", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.instances.create({
      name: "sandbox-project",
      image: "sandbox-project:latest",
      labels: { "sandbox.project": "project", "sandbox.hash": "expected" },
      status: "running",
    });
    const runtime = (await harness.provider.resolve()).runtime;
    const list = runtime.instances.list.bind(runtime.instances);
    let queries = 0;
    runtime.instances.list = async (query) => {
      const instances = await list(query);
      if (query?.labels?.["sandbox.project"] === "project" && ++queries <= 4)
        return [];
      return instances;
    };
    runtime.instances.startDetached = () =>
      Promise.reject(new SandboxInstanceNameConflictError("sandbox-project"));
    const sleepDurations: number[] = [];
    const clock: Clock = {
      now: () => 0,
      sleep: (milliseconds) => {
        sleepDurations.push(milliseconds);
        return Promise.resolve();
      },
    };
    const result = await runWithTestLogger(
      () => findOrCreateContainer(runtime, "project", "expected", createSpec()),
      { clock },
    );
    expect(result).toEqual({
      containerName: "sandbox-project",
      created: false,
    });
    expect(sleepDurations).toEqual([250, 250, 250, 250]);
  });

  test("keeps an obsolete container with active sessions", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.instances.create({
      name: "sandbox-project",
      image: "sandbox-project:latest",
      labels: { "sandbox.project": "project", "sandbox.hash": "old" },
      status: "running",
      sessions: [{ pid: "123", command: "zsh" }],
    });
    const runtime = (await harness.provider.resolve()).runtime;
    const result = await runWithTestLogger(() =>
      findOrCreateContainer(runtime, "project", "new", createSpec()),
    );
    expect(result).toEqual({
      containerName: "sandbox-project-2",
      created: true,
    });
    expect(
      harness.instances.all().filter((entry) => entry.status === "running"),
    ).toHaveLength(2);
  });

  test("creates a fresh container with no hash label", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    const runtime = (await harness.provider.resolve()).runtime;
    const name = await runWithTestLogger(() =>
      createFreshContainer(runtime, "project", createSpec()),
    );
    expect(name).toBe("sandbox-project");
    expect(harness.instances.find(name)?.labels).not.toHaveProperty(
      "sandbox.hash",
    );
  });

  test("waits for the Sandbox readiness marker", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.instances.create({
      name: "sandbox-project",
      image: "sandbox-project:latest",
      labels: { "sandbox.project": "project" },
      status: "running",
      readyAfterAttempts: 0,
    });
    const runtime = (await harness.provider.resolve()).runtime;
    await expect(
      runWithTestLogger(async () => {
        await using _session = await prepareContainerSession({
          containers: runtime.instances,
          containerId: "sandbox-project",
          timeoutMs: 500,
        });
      }),
    ).resolves.toBeUndefined();
  });

  test("reports bounded logs when readiness fails", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.instances.create({
      name: "sandbox-project",
      image: "sandbox-project:latest",
      labels: { "sandbox.project": "project" },
      status: "exited",
      logs: "startup failed",
    });
    const runtime = (await harness.provider.resolve()).runtime;
    await expect(
      runWithTestLogger(() =>
        prepareContainerSession({
          containers: runtime.instances,
          containerId: "sandbox-project",
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("container state is exited");
  });
});
