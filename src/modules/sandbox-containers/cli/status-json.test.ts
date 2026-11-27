import { describe, expect, test } from "bun:test";
import type { ContainerStatusInfo } from "../lifecycle/container-status.js";
import { toStatusDocument } from "./status-json.js";

const SESSION_ID = "6f1c0d3e-9a4b-4c2d-8e7f-1a2b3c4d5e6f";

function containerInfo(
  overrides: Partial<ContainerStatusInfo> = {},
): ContainerStatusInfo {
  return {
    id: "3f9c2a7d1e8b4c6a9f0e2d5b7a1c3e8f6d4b2a0c9e7f5d3b1a8c6e4f2d0b9a7c",
    name: "sandbox-my-app-1a2b",
    projectSlug: "my-app-1a2b",
    projectDir: "/home/me/my-app",
    image: "sha256:fe5cb42fc078",
    startedAt: new Date("2026-11-16T08:58:55.412Z"),
    hash: "b456f6b2807a",
    ready: true,
    sessions: [],
    ...overrides,
  };
}

describe("toStatusDocument", () => {
  test("maps a container and its sessions to the contract fields", () => {
    const document = toStatusDocument({
      projectSlug: "my-app-1a2b",
      sessionId: null,
      runtime: "podman",
      containers: [
        containerInfo({
          sessions: [
            {
              pid: 74,
              startedAt: new Date("2026-11-16T10:02:10+01:00"),
              id: SESSION_ID,
              command: ["claude", "--resume"],
              title: "claude",
            },
          ],
        }),
      ],
    });

    expect(document).toEqual({
      schemaVersion: 1,
      runtime: "podman",
      containers: [
        {
          containerId:
            "3f9c2a7d1e8b4c6a9f0e2d5b7a1c3e8f6d4b2a0c9e7f5d3b1a8c6e4f2d0b9a7c",
          name: "sandbox-my-app-1a2b",
          project: { slug: "my-app-1a2b", dir: "/home/me/my-app" },
          image: "sha256:fe5cb42fc078",
          startedAt: "2026-11-16T08:58:55.412Z",
          ready: true,
          hash: "b456f6b2807a",
          sessions: [
            {
              id: SESSION_ID,
              pid: 74,
              startedAt: "2026-11-16T09:02:10.000Z",
              command: ["claude", "--resume"],
            },
          ],
        },
      ],
    });
  });

  test("keeps unknown values as null", () => {
    const document = toStatusDocument({
      projectSlug: null,
      sessionId: null,
      runtime: "docker",
      containers: [
        containerInfo({
          projectDir: null,
          startedAt: null,
          hash: null,
          ready: null,
          sessions: null,
        }),
        containerInfo({
          sessions: [
            {
              pid: 361,
              startedAt: new Date("2026-11-16T09:00:00Z"),
              id: null,
              command: null,
              title: "pi",
            },
          ],
        }),
      ],
    });

    expect(document.containers[0]).toMatchObject({
      project: { dir: null },
      startedAt: null,
      hash: null,
      ready: null,
      sessions: null,
    });
    expect(document.containers[1]?.sessions).toEqual([
      {
        id: null,
        pid: 361,
        startedAt: "2026-11-16T09:00:00.000Z",
        command: null,
      },
    ]);
  });

  test("keeps the runtime with no containers", () => {
    expect(
      toStatusDocument({
        projectSlug: "my-app-1a2b",
        sessionId: null,
        runtime: "apple-container",
        containers: [],
      }),
    ).toEqual({ schemaVersion: 1, runtime: "apple-container", containers: [] });
  });
});
