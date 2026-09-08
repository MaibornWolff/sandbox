import { describe, expect, test } from "bun:test";
import { createStatefulContainerRuntimeHarness } from "#platform/container-runtime/__test__/index.js";
import { getContainerDisplay } from "./container-display.js";

const available = {
  available: true,
  display: ":2",
  socketPath: "/tmp/.X11-unix/X2",
  platform: "linux" as const,
};

describe("getContainerDisplay", () => {
  test("returns null when X11 is unavailable", async () => {
    const runtime =
      await createStatefulContainerRuntimeHarness().provider.resolve();
    expect(
      getContainerDisplay(runtime, {
        ...available,
        available: false,
        display: null,
      }),
    ).toBeNull();
  });

  test("maps the host display through Docker and Podman", async () => {
    const docker = await createStatefulContainerRuntimeHarness({
      runtime: "docker",
    }).provider.resolve();
    const podman = await createStatefulContainerRuntimeHarness({
      runtime: "podman",
    }).provider.resolve();
    expect(getContainerDisplay(docker, available)).toBe(
      "host.docker.internal:2",
    );
    expect(getContainerDisplay(podman, available)).toBe(
      "host.containers.internal:2",
    );
  });
});
