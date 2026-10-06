import { describe, expect, test } from "bun:test";
import { getContainerDisplay } from "./container-display.js";

const available = {
  available: true,
  display: ":2",
  socketPath: "/tmp/.X11-unix/X2",
  platform: "linux" as const,
};

describe("getContainerDisplay", () => {
  test("returns null when X11 is unavailable", () => {
    expect(
      getContainerDisplay("host.docker.internal", {
        ...available,
        available: false,
        display: null,
      }),
    ).toBeNull();
  });

  test.each([
    "host.docker.internal",
    "host.containers.internal",
    "host.container.internal",
  ])("maps %s through the resolved host-access name", (hostAccessName) => {
    expect(getContainerDisplay(hostAccessName, available)).toBe(
      `${hostAccessName}:2`,
    );
  });
});
