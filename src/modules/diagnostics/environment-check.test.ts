import { describe, expect, it } from "bun:test";
import {
  type EnvironmentStatus,
  renderEnvironmentStatus,
} from "./environment-check.js";

function status(overrides: Partial<EnvironmentStatus>): EnvironmentStatus {
  return {
    docker: {
      available: false,
      runtime: null,
      memoryOk: false,
      memoryGB: null,
    },
    x11: { available: false, display: null, xhostConfigured: false },
    ...overrides,
  };
}

describe("renderEnvironmentStatus", () => {
  it("renders an available runtime and memory", () => {
    const output = renderEnvironmentStatus(
      status({
        docker: {
          available: true,
          runtime: "docker",
          memoryOk: true,
          memoryGB: 8,
        },
      }),
    );
    expect(output).toContain("docker");
    expect(output).toContain("8.0 GB");
  });

  it("renders unavailable runtime and low memory guidance", () => {
    expect(renderEnvironmentStatus(status({}))).toContain("Not available");
    const output = renderEnvironmentStatus(
      status({
        docker: {
          available: true,
          runtime: "podman",
          memoryOk: false,
          memoryGB: 2,
        },
      }),
    );
    expect(output).toContain("2.0 GB");
    expect(output).toContain("recommended");
  });

  it("renders configured and unconfigured X11", () => {
    expect(
      renderEnvironmentStatus(
        status({
          x11: { available: true, display: ":0", xhostConfigured: true },
        }),
      ),
    ).toContain(":0");
    expect(
      renderEnvironmentStatus(
        status({
          x11: { available: true, display: ":0", xhostConfigured: false },
        }),
      ),
    ).toContain("setup-x11");
  });
});
