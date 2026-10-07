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
  test("filters instances by state and labels", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.instances.create({
      name: "running-match",
      image: "sha256:image",
      labels: { "sandbox.project": "project-a" },
      status: "running",
    });
    harness.instances.create({
      name: "other-project",
      image: "sha256:image",
      labels: { "sandbox.project": "project-b" },
      status: "exited",
    });
    const { runtime } = await harness.provider.resolve();
    const instances = await runtime.instances.list({
      all: true,
      labels: { "sandbox.project": "project-a" },
      states: ["running"],
    });
    expect(instances.map((instance) => instance.name)).toEqual([
      "running-match",
    ]);
  });

  test("returns the current compatibility identity from one runtime instance", async () => {
    const harness = createStatefulContainerRuntimeHarness({
      runtime: "apple-container",
    });
    const selection = await harness.provider.resolve();
    harness.system.givenCompatibilityIdentity("bridge-a");
    await expect(selection.runtime.getCompatibilityIdentity()).resolves.toBe(
      "bridge-a",
    );

    harness.system.givenCompatibilityIdentity("bridge-b");
    await expect(selection.runtime.getCompatibilityIdentity()).resolves.toBe(
      "bridge-b",
    );
  });

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

  test("refuses removal of attached storage and preserves its contents", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.storage.create({
      name: "current",
      files: { "nested/file": "content" },
    });
    const { runtime } = await harness.provider.resolve();
    const target = await runtime.storage.ensure({
      key: "current",
      scope: "global",
    });
    harness.instances.create({
      name: "consumer",
      image: "sha256:image",
      labels: {},
      status: "running",
      mounts: [
        {
          type: "volume",
          volumeName: "current",
          targetPath: "/cache",
          readOnly: false,
        },
      ],
    });
    await expect(runtime.storage.remove(target)).rejects.toThrow(
      "referenced by container",
    );
    expect(harness.storage.find("current")?.files).toEqual({
      "nested/file": "content",
    });
  });
});
