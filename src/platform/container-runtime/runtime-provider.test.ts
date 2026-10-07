import { describe, expect, test } from "bun:test";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import {
  createProductionRuntimeProvider,
  getRuntimeProvider,
  provideRuntimeProvider,
  type SandboxRuntimeProvider,
} from "./index.js";

describe("production container runtime provider", () => {
  test("resolves a configured runtime and creates its service", async () => {
    const processes = createProcessTestHarness();
    const provider = createProductionRuntimeProvider(processes.manager);

    const service = await runWithDependencies(
      [
        provideLogger(
          createLogger(
            {
              now: () => 0,
              sleep: () => Promise.resolve(),
            },
            () => undefined,
            {},
          ),
        ),
      ],
      () =>
        provider.resolve({
          configuredRuntime: "podman",
          options: { "apple-container": { dns: "host-ipv6" } },
        }),
    );

    expect(service.runtime.runtime).toBe("podman");
    expect(service.imageOwnershipKey).toBe("podman");
    expect(processes.requests).toEqual([]);
  });

  test("resolves only the provider bound to the active scope", () => {
    const provider: SandboxRuntimeProvider = {
      resolve: () => Promise.reject(new Error("not used")),
    };

    expect(
      runWithDependencies([provideRuntimeProvider(provider)], () =>
        getRuntimeProvider(),
      ),
    ).toBe(provider);
    expect(() => getRuntimeProvider()).toThrow(
      'Dependency "container runtime provider" is not registered in the active scope.',
    );
  });
});
