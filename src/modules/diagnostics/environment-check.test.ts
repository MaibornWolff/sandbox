import { describe, expect, it } from "bun:test";
import {
  type DockerStatus,
  renderEnvironmentStatus,
} from "./environment-check.js";

function status(overrides: Partial<DockerStatus>): DockerStatus {
  return {
    available: false,
    runtime: null,
    memoryOk: false,
    memoryGB: null,
    memoryScope: "unknown",
    ...overrides,
  };
}

describe("renderEnvironmentStatus", () => {
  it("renders an available runtime and memory", () => {
    const output = renderEnvironmentStatus(
      status({
        available: true,
        runtime: "docker",
        memoryOk: true,
        memoryGB: 8,
        memoryScope: "shared-runtime-vm",
      }),
    );
    expect(output).toContain("docker");
    expect(output).toContain("8.0 GB");
  });

  it("renders unavailable runtime and low memory guidance", () => {
    expect(renderEnvironmentStatus(status({}))).toContain("Not available");
    const output = renderEnvironmentStatus(
      status({
        available: true,
        runtime: "podman",
        memoryOk: false,
        memoryGB: 2,
        memoryScope: "shared-runtime-vm",
      }),
    );
    expect(output).toContain("2.0 GB");
    expect(output).toContain("recommended");
  });
});
