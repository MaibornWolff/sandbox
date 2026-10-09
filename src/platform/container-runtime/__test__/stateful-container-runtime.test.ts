import { describe, expect, test } from "bun:test";
import type { SandboxInstanceSpec } from "../index.js";
import { createStatefulContainerRuntimeHarness } from "./index.js";

function createSpec(name = "managed"): SandboxInstanceSpec {
  return {
    name,
    image: { reference: "sha256:image", digest: "sha256:image" },
    labels: { "sandbox.project": "project-a" },
    environment: {},
    mounts: [],
    ports: [],
    init: true,
    removeOnExit: true,
    resources: {},
    security: { capabilities: ["NET_ADMIN"], nestedContainerRuntime: false },
  };
}

describe("stateful sandbox runtime harness", () => {
  test("returns an opaque reference after detached startup", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    const { runtime } = await harness.provider.resolve();
    await expect(
      runtime.instances.startDetached(createSpec()),
    ).resolves.toEqual({
      id: "container-1",
    });
    expect(harness.instances.find("managed")?.image).toBe("sha256:image");
  });

  test("returns immutable image identity from a build", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.images.givenNextBuild({ id: "sha256:child" });
    const { imageBuilder } = await harness.provider.resolve();
    await expect(
      imageBuilder.build({
        tag: "sandbox-user:latest",
        dockerfilePath: "/build/Dockerfile",
        contextDirectory: "/build",
        buildArguments: {},
        labels: { "dockerfile.hash": "bbbbbbbbbbbb" },
        secrets: [],
        cachePolicy: "bypass",
        output: "silent",
      }),
    ).resolves.toEqual({
      reference: "sha256:child",
      digest: "sha256:child",
    });
  });
});
