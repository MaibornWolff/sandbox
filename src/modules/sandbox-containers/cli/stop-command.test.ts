import { describe, expect, test } from "bun:test";
import { createStatefulContainerRuntimeHarness } from "#platform/container-runtime/__test__/index.js";
import type { ContainerSession } from "#platform/container-system/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { buildStopWarning, stopContainers } from "./stop-command.js";

function session(pid: number, command: string): ContainerSession {
  return {
    pid,
    startedAt: new Date(Date.UTC(2026, 0, 1)),
    id: null,
    command: command.split(" "),
    title: command,
  };
}

describe("sandbox stop session cancellation", () => {
  test("signals discovered sessions before stopping their container", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    const container = harness.instances.create({
      name: "managed",
      image: "sandbox-project:latest",
      labels: {},
      status: "running",
    });
    container.givenExecResult(["kill", "-TERM", "--", "41", "42"], "");
    const runtime = (await harness.provider.resolve()).runtime;

    const stopped = await runWithTestLogger(() =>
      stopContainers(runtime, [
        {
          container: container.snapshot(),
          sessions: [session(41, "sleep 30"), session(42, "zsh")],
        },
      ]),
    );

    expect(stopped).toBe(1);
    expect(harness.events()).toEqual([
      {
        type: "container.exec",
        containerId: container.id,
        command: ["kill", "-TERM", "--", "41", "42"],
        options: {},
      },
      { type: "container.stop", containerId: container.id },
    ]);
  });

  test("still stops a container when explicit session cancellation fails", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    const container = harness.instances.create({
      name: "managed",
      image: "sandbox-project:latest",
      labels: {},
      status: "running",
    });
    container.givenExecResult(
      ["kill", "-TERM", "--", "41"],
      new Error("session already exited"),
    );
    const runtime = (await harness.provider.resolve()).runtime;

    const stopped = await runWithTestLogger(() =>
      stopContainers(runtime, [
        {
          container: container.snapshot(),
          sessions: [session(41, "sleep 30")],
        },
      ]),
    );

    expect(stopped).toBe(1);
    expect(harness.events().at(-1)).toEqual({
      type: "container.stop",
      containerId: container.id,
    });
  });

  test("stops a container with unknown sessions without signaling them", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    const container = harness.instances.create({
      name: "managed",
      image: "sandbox-project:latest",
      labels: {},
      status: "running",
    });
    const runtime = (await harness.provider.resolve()).runtime;

    const stopped = await runWithTestLogger(() =>
      stopContainers(runtime, [
        { container: container.snapshot(), sessions: null },
      ]),
    );

    expect(stopped).toBe(1);
    expect(harness.events()).toEqual([
      { type: "container.stop", containerId: container.id },
    ]);
  });
});

describe("buildStopWarning", () => {
  test("describes multiple containers and active sessions", () => {
    const warning = buildStopWarning([
      {
        container: {
          id: "a",
          name: "sandbox-proj-1234",
          image: "sandbox-base:latest",
        },
        sessions: [session(1, "zsh"), session(2, "node")],
      },
      {
        container: {
          id: "b",
          name: "sandbox-proj-1234-2",
          image: "sandbox-base:latest",
        },
        sessions: [session(3, "bun test")],
      },
    ]);

    expect(warning).toContain("2 container(s) with 3 active session(s)");
    expect(warning).toContain("2 sessions");
    expect(warning).toContain("1 session");
    expect(warning).toContain("cancel all open sessions");
  });

  test("describes an idle container without an active-session warning", () => {
    const warning = buildStopWarning([
      {
        container: {
          id: "a",
          name: "sandbox-proj-1234",
          image: "sandbox-base:latest",
        },
        sessions: [],
      },
    ]);

    expect(warning).toContain("1 container(s)");
    expect(warning).toContain("no sessions");
    expect(warning).not.toContain("active session(s)");
    expect(warning).toContain("Continue?");
  });

  test("warns that unknown sessions end without a session count", () => {
    const warning = buildStopWarning([
      {
        container: {
          id: "a",
          name: "sandbox-proj-1234",
          image: "sandbox-base:latest",
        },
        sessions: null,
      },
    ]);

    expect(warning.split("\n")[0]).toBe(
      "This will stop and remove 1 container(s):",
    );
    expect(warning).toContain("sessions unknown");
    expect(warning).toEndWith("This will cancel all open sessions. Continue?");
  });

  test("counts only the known sessions next to unknown sessions", () => {
    const warning = buildStopWarning([
      {
        container: {
          id: "a",
          name: "sandbox-proj-1234",
          image: "sandbox-base:latest",
        },
        sessions: [session(1, "zsh"), session(2, "node")],
      },
      {
        container: {
          id: "b",
          name: "sandbox-proj-1234-2",
          image: "sandbox-base:latest",
        },
        sessions: null,
      },
    ]);

    expect(warning.split("\n")[0]).toBe(
      "This will stop and remove 2 container(s) with 2 active session(s):",
    );
    expect(warning).toContain("2 sessions");
    expect(warning).toContain("sessions unknown");
    expect(warning).toEndWith("This will cancel all open sessions. Continue?");
  });
});
