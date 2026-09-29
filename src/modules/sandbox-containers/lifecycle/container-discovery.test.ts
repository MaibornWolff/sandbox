import { describe, expect, test } from "bun:test";
import { createStatefulContainerRuntimeHarness } from "#platform/container-runtime/__test__/index.js";
import { runWithCapturedLogs } from "#test/captured-logger.js";
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
    const first = runtime.containers.create({
      id: "abc123",
      name: "sandbox-my-project",
      image: "localhost/sandbox-my-project:latest",
      labels: { [PROJECT_LABEL]: "my-project" },
      status: "running",
    });
    runtime.containers.create({
      id: "ignored",
      name: "unrelated",
      image: "other:latest",
      labels: {},
      status: "running",
    });
    const service = await runtime.provider.resolve();

    expect(await findSandboxContainers(service)).toEqual([
      {
        id: first.id,
        name: "sandbox-my-project",
        image: "sandbox-my-project:latest",
      },
    ]);
    expect(runtime.events()).toContainEqual({
      type: "container.list",
      options: { all: true, labelFilter: PROJECT_LABEL },
    });
  });

  test("applies running, exited, and project label filters", async () => {
    const runtime = createStatefulContainerRuntimeHarness();
    runtime.containers.create({
      name: "sandbox-current-running",
      image: "sandbox-base:latest",
      labels: { [PROJECT_LABEL]: "current" },
      status: "running",
    });
    runtime.containers.create({
      name: "sandbox-current-exited",
      image: "sandbox-base:latest",
      labels: { [PROJECT_LABEL]: "current" },
      status: "exited",
    });
    runtime.containers.create({
      name: "sandbox-other",
      image: "sandbox-base:latest",
      labels: { [PROJECT_LABEL]: "other" },
      status: "running",
    });
    const service = await runtime.provider.resolve();

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
    expect(runtime.events()).toEqual(
      expect.arrayContaining([
        {
          type: "container.list",
          options: {
            statusFilter: ["running"],
            labelFilter: `${PROJECT_LABEL}=current`,
          },
        },
        {
          type: "container.list",
          options: {
            statusFilter: ["exited"],
            labelFilter: `${PROJECT_LABEL}=current`,
          },
        },
      ]),
    );
  });

  test("returns an empty list for no matches or runtime failure", async () => {
    const empty = createStatefulContainerRuntimeHarness();
    expect(await findSandboxContainers(await empty.provider.resolve())).toEqual(
      [],
    );

    const failed = createStatefulContainerRuntimeHarness();
    failed.system.fail("container.list", new Error("daemon offline"));
    const messages: string[] = [];
    expect(
      await runWithCapturedLogs(messages, async () =>
        findSandboxContainers(await failed.provider.resolve()),
      ),
    ).toEqual([]);
    expect(messages.join("\n")).toContain("daemon offline");
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
