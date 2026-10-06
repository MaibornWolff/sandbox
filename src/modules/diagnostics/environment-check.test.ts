import { describe, expect, it } from "bun:test";
import { provideRuntimeProvider } from "#platform/container-runtime/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createTestTerminal } from "#platform/terminal/__test__/index.js";
import { provideTerminal } from "#platform/terminal/index.js";
import {
  type DockerStatus,
  displayEnvironmentCheck,
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

describe("displayEnvironmentCheck", () => {
  it("checks the runtime without host or native clipboard dependencies", async () => {
    await using cleanup = new AsyncDisposableStack();
    const terminal = createTestTerminal();
    cleanup.defer(() => terminal.dispose());
    let resolutions = 0;
    await runWithDependencies(
      [
        provideTerminal(terminal.io),
        provideRuntimeProvider({
          resolve: async () => {
            resolutions += 1;
            throw new Error("No runtime installed");
          },
        }),
      ],
      () => displayEnvironmentCheck(),
    );
    expect(resolutions).toBe(1);
    expect(terminal.stdout()).toContain("Not available");
    expect(terminal.stderr()).toBe("");
  });
});

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
