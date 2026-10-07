import { describe, expect, test } from "bun:test";
import { createStatefulContainerRuntimeHarness } from "#platform/container-runtime/__test__/index.js";
import {
  findAvailableName,
  findSandboxContainers,
} from "./container-discovery.js";

const PROJECT_LABEL = "sandbox.project";

describe("findSandboxContainers", () => {
  test("finds labelled containers and normalizes Podman image references", async () => {
    const runtime = createStatefulContainerRuntimeHarness({
      runtime: "podman",
    });
    const first = runtime.instances.create({
      id: "abc123",
      name: "sandbox-my-project",
      image: "localhost/sandbox-my-project:latest",
      labels: { [PROJECT_LABEL]: "my-project" },
      status: "running",
    });
    runtime.instances.create({
      id: "ignored",
      name: "unrelated",
      image: "other:latest",
      labels: {},
      status: "running",
    });
    const service = (await runtime.provider.resolve()).runtime;

    expect(await findSandboxContainers(service)).toEqual([
      {
        id: first.id,
        name: "sandbox-my-project",
        image: "sandbox-my-project:latest",
      },
    ]);
  });

  test("applies running, exited, and project label filters", async () => {
    const runtime = createStatefulContainerRuntimeHarness();
    runtime.instances.create({
      name: "sandbox-current-running",
      image: "sandbox-base:latest",
      labels: { [PROJECT_LABEL]: "current" },
      status: "running",
    });
    runtime.instances.create({
      name: "sandbox-current-exited",
      image: "sandbox-base:latest",
      labels: { [PROJECT_LABEL]: "current" },
      status: "exited",
    });
    runtime.instances.create({
      name: "sandbox-other",
      image: "sandbox-base:latest",
      labels: { [PROJECT_LABEL]: "other" },
      status: "running",
    });
    const service = (await runtime.provider.resolve()).runtime;

    expect(
      await findSandboxContainers(service, {
        status: "running",
        projectSlug: "current",
      }),
    ).toHaveLength(1);
    expect(
      await findSandboxContainers(service, {
        status: "exited",
        projectSlug: "current",
      }),
    ).toHaveLength(1);
    expect(
      await findSandboxContainers(service, { status: "all" }),
    ).toHaveLength(3);
  });

  test("distinguishes no matches from runtime failure", async () => {
    const empty = createStatefulContainerRuntimeHarness();
    expect(
      await findSandboxContainers((await empty.provider.resolve()).runtime),
    ).toEqual([]);

    const failed = createStatefulContainerRuntimeHarness();
    failed.system.fail("container.list", new Error("daemon offline"));
    await expect(
      findSandboxContainers((await failed.provider.resolve()).runtime),
    ).rejects.toThrow("daemon offline");
  });
});

describe("findAvailableName", () => {
  test("returns the base name or first available suffix", () => {
    expect(findAvailableName("sandbox-project", new Set())).toBe(
      "sandbox-project",
    );
    expect(
      findAvailableName(
        "sandbox-project",
        new Set(["sandbox-project", "sandbox-project-2", "sandbox-project-4"]),
      ),
    ).toBe("sandbox-project-3");
  });
});
