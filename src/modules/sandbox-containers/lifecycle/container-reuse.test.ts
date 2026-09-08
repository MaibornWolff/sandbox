import { describe, expect, test } from "bun:test";
import {
  createStatefulContainerRuntimeHarness,
  type StatefulContainerRuntimeHarness,
} from "#platform/container-runtime/__test__/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { SANDBOX_HASH_LABEL } from "../container-hashing.js";
import {
  createFreshContainer,
  findOrCreateContainer,
  waitForReady,
} from "./container-reuse.js";

function runInLifecycleScope<T>(
  callback: () => Promise<T> | T,
): Promise<T> | T {
  return runWithTestLogger(callback);
}

async function runtimeService(runtime: StatefulContainerRuntimeHarness) {
  return runtime.provider.resolve();
}

describe("findOrCreateContainer", () => {
  test("creates a detached managed container with the requested hash", async () => {
    const runtime = createStatefulContainerRuntimeHarness();
    const service = await runtimeService(runtime);
    const result = await runInLifecycleScope(() =>
      findOrCreateContainer(
        service,
        "project-a1b2",
        "hash-1",
        ["-e", "SANDBOX=1", "sandbox-base:latest"],
        "sandbox-base:latest",
      ),
    );

    expect(result).toEqual({
      containerName: "sandbox-project-a1b2",
      created: true,
    });
    expect(runtime.containers.find(result.containerName)).toMatchObject({
      labels: { [SANDBOX_HASH_LABEL]: "hash-1" },
      status: "running",
    });
    const creation = runtime
      .events()
      .find((event) => event.type === "container.create");
    expect(creation).toMatchObject({
      type: "container.create",
      options: {
        image: "sandbox-base:latest",
        extraArgs: ["-e", "SANDBOX=1"],
      },
    });
  });

  test("reuses a healthy matching container and preserves mismatched sessions", async () => {
    const runtime = createStatefulContainerRuntimeHarness();
    const matching = runtime.containers.create({
      name: "sandbox-project-a1b2",
      image: "sandbox-base:latest",
      labels: {
        "sandbox.project": "project-a1b2",
        [SANDBOX_HASH_LABEL]: "match",
      },
      status: "running",
    });
    runtime.containers.create({
      name: "sandbox-project-a1b2-2",
      image: "sandbox-base:latest",
      labels: {
        "sandbox.project": "project-a1b2",
        [SANDBOX_HASH_LABEL]: "other",
      },
      status: "running",
      sessions: [{ pid: "42", command: "zsh" }],
    });
    const service = await runtimeService(runtime);
    const result = await runInLifecycleScope(() =>
      findOrCreateContainer(
        service,
        "project-a1b2",
        "match",
        ["sandbox-base:latest"],
        "sandbox-base:latest",
      ),
    );

    expect(result).toEqual({
      containerName: matching.snapshot().name,
      created: false,
    });
    expect(runtime.containers.all()).toHaveLength(2);
    expect(
      runtime.events().some((event) => event.type === "container.label"),
    ).toBe(false);
  });

  test("removes an obsolete container when it has no active sessions", async () => {
    const runtime = createStatefulContainerRuntimeHarness();
    const obsolete = runtime.containers.create({
      name: "sandbox-project-a1b2",
      image: "sandbox-base:latest",
      labels: {
        "sandbox.project": "project-a1b2",
        [SANDBOX_HASH_LABEL]: "old-hash",
      },
      status: "running",
    });
    const service = await runtimeService(runtime);

    const result = await runInLifecycleScope(() =>
      findOrCreateContainer(
        service,
        "project-a1b2",
        "new-hash",
        ["sandbox-base:latest"],
        "sandbox-base:latest",
      ),
    );

    expect(obsolete.snapshot().status).toBe("removed");
    expect(result.containerName).toBe("sandbox-project-a1b2");
  });

  test("keeps an obsolete container when removal fails", async () => {
    const runtime = createStatefulContainerRuntimeHarness();
    runtime.containers.create({
      name: "sandbox-project-a1b2",
      image: "sandbox-base:latest",
      labels: {
        "sandbox.project": "project-a1b2",
        [SANDBOX_HASH_LABEL]: "old-hash",
      },
      status: "running",
    });
    runtime.system.fail("container.remove", new Error("container changed"));
    const service = await runtimeService(runtime);

    const result = await runInLifecycleScope(() =>
      findOrCreateContainer(
        service,
        "project-a1b2",
        "new-hash",
        ["sandbox-base:latest"],
        "sandbox-base:latest",
      ),
    );

    expect(result.containerName).toBe("sandbox-project-a1b2-2");
  });

  test("removes stopped containers before choosing an available name", async () => {
    const runtime = createStatefulContainerRuntimeHarness();
    runtime.containers.create({
      name: "sandbox-project-a1b2",
      image: "sandbox-base:latest",
      labels: { "sandbox.project": "project-a1b2" },
      status: "exited",
    });
    const service = await runtimeService(runtime);
    const result = await runInLifecycleScope(() =>
      findOrCreateContainer(
        service,
        "project-a1b2",
        "new-hash",
        ["sandbox-base:latest"],
        "sandbox-base:latest",
      ),
    );

    expect(result.containerName).toBe("sandbox-project-a1b2");
    expect(
      runtime.events().some((event) => event.type === "container.remove"),
    ).toBe(true);
  });

  test("preserves non-conflict creation failures", async () => {
    const runtime = createStatefulContainerRuntimeHarness();
    runtime.system.fail("container.create", new Error("daemon offline"));
    const service = await runtimeService(runtime);
    await expect(
      runInLifecycleScope(() =>
        findOrCreateContainer(
          service,
          "project-a1b2",
          "hash",
          ["sandbox-base:latest"],
          "sandbox-base:latest",
        ),
      ),
    ).rejects.toThrow("daemon offline");
  });
});

describe("createFreshContainer", () => {
  test("uses a suffix when another project container is running", async () => {
    const runtime = createStatefulContainerRuntimeHarness();
    runtime.containers.create({
      name: "sandbox-project-a1b2",
      image: "sandbox-base:latest",
      labels: { "sandbox.project": "project-a1b2" },
      status: "running",
    });
    const service = await runtimeService(runtime);
    const name = await runInLifecycleScope(() =>
      createFreshContainer(
        service,
        "project-a1b2",
        ["-e", "SANDBOX=1", "sandbox-base:latest"],
        "sandbox-base:latest",
      ),
    );
    expect(name).toBe("sandbox-project-a1b2-2");
  });
});

describe("waitForReady", () => {
  test("returns immediately for a ready container", async () => {
    const runtime = createStatefulContainerRuntimeHarness();
    const container = runtime.containers.create({
      name: "ready",
      image: "sandbox-base:latest",
      labels: {},
      status: "running",
    });
    const service = await runtimeService(runtime);
    await runInLifecycleScope(() => waitForReady(service, container.id));
    expect(container.snapshot().readinessAttempts).toBe(1);
  });

  test("uses one runtime wait until readiness", async () => {
    const runtime = createStatefulContainerRuntimeHarness();
    const container = runtime.containers.create({
      name: "delayed",
      image: "sandbox-base:latest",
      labels: {},
      status: "running",
      readyAfterAttempts: 2,
    });
    const service = await runtimeService(runtime);
    await runInLifecycleScope(() => waitForReady(service, container.id, 5_000));
    expect(container.snapshot().readinessAttempts).toBe(3);
    expect(
      runtime.events().filter((event) => event.type === "container.wait-ready"),
    ).toHaveLength(1);
  });

  test("times out deterministically and reports managed logs", async () => {
    const runtime = createStatefulContainerRuntimeHarness();
    const container = runtime.containers.create({
      name: "never-ready",
      image: "sandbox-base:latest",
      labels: {},
      status: "running",
      readyAfterAttempts: 10,
      logs: "entrypoint waiting",
    });
    const service = await runtimeService(runtime);
    const execution = runInLifecycleScope(() =>
      waitForReady(service, container.id, 200),
    );
    await expect(execution).rejects.toThrow(
      "did not become ready within 200ms",
    );
    expect(
      runtime.events().some((event) => event.type === "container.logs"),
    ).toBe(true);
  });

  test("detects a stopped-container race without waiting for timeout", async () => {
    const runtime = createStatefulContainerRuntimeHarness();
    const container = runtime.containers.create({
      name: "stops",
      image: "sandbox-base:latest",
      labels: {},
      status: "running",
    });
    container.givenStopsOnReadinessAttempt(1);
    const service = await runtimeService(runtime);
    await expect(
      runInLifecycleScope(() => waitForReady(service, container.id)),
    ).rejects.toThrow("crashed during startup");
  });
});
