import { describe, expect, test } from "bun:test";
import { createStatefulContainerRuntimeHarness } from "./__test__/index.js";
import { getSandboxStorageNativeName } from "./sandbox-adapter.js";

describe("createSandboxImageBuilder", () => {
  test.each(["docker", "podman"] as const)(
    "resolves and verifies a complete %s image identity",
    async (runtime) => {
      const id = "a".repeat(64);
      const nativeId = runtime === "podman" ? id : `sha256:${id}`;
      const harness = createStatefulContainerRuntimeHarness({ runtime });
      harness.images.create({
        id: nativeId,
        references: ["sandbox-base:latest"],
        labels: { "sandbox.managed": "true" },
      });
      const { imageBuilder } = await harness.provider.resolve();
      const image = await imageBuilder.build({
        tag: "sandbox-base:latest",
        dockerfilePath: "/build/Dockerfile",
        contextDirectory: "/build",
        buildArguments: {},
        labels: { "sandbox.managed": "true" },
        secrets: [],
        cachePolicy: "use",
        output: "silent",
      });

      expect(image.digest).toBe(`sha256:${id}`);
      expect(await imageBuilder.isAvailable(image)).toBe(true);
      expect(
        await imageBuilder.isAvailable({
          ...image,
          digest: `sha256:${"b".repeat(64)}`,
        }),
      ).toBe(false);
    },
  );

  test.each([
    { localDigest: null, available: false },
    { localDigest: "sha256:abc001", available: true },
    { localDigest: "sha256:abc002", available: false },
  ])(
    "checks the stored reference and content identity: %j",
    async ({ localDigest, available }) => {
      const harness = createStatefulContainerRuntimeHarness({
        runtime: "apple-container",
      });
      if (localDigest) {
        harness.images.create({
          id: localDigest,
          references: ["sandbox-user:latest"],
        });
      }
      const { imageBuilder } = await harness.provider.resolve();

      expect(
        await imageBuilder.isAvailable({
          reference: "sandbox-user:latest",
          digest: "sha256:abc001",
        }),
      ).toBe(available);
    },
  );

  test("preserves image lookup failures", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    const failure = new Error("image store unavailable");
    harness.system.fail("image.inspect", failure);
    const { imageBuilder } = await harness.provider.resolve();

    await expect(
      imageBuilder.isAvailable({
        reference: "sandbox-base:latest",
        digest: "sha256:abc001",
      }),
    ).rejects.toBe(failure);
    expect(harness.images.builds()).toHaveLength(0);
  });

  test("forwards exactly the supplied cleanup candidates after a build", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.images.create({
      id: "sha256:replaced",
      references: ["sandbox-base:latest"],
    });
    harness.images.givenNextBuild({ id: "sha256:replacement" });
    const { imageBuilder } = await harness.provider.resolve();

    await imageBuilder.build({
      tag: "sandbox-base:latest",
      dockerfilePath: "/build/Dockerfile",
      contextDirectory: "/build",
      buildArguments: {},
      labels: { "sandbox.managed": "true" },
      secrets: [],
      cachePolicy: "bypass",
      output: "silent",
    });
    await imageBuilder.removeUnused({
      candidates: ["sha256:supplied"],
      managedLabel: { key: "sandbox.managed", value: "true" },
    });

    expect(
      harness.events().find((event) => event.type === "image.cleanup"),
    ).toEqual({
      type: "image.cleanup",
      request: {
        candidates: ["sha256:supplied"],
        managedLabel: { key: "sandbox.managed", value: "true" },
      },
    });
  });
});

describe("createSandboxStorageOperations", () => {
  test("preserves existing global storage and separates project storage", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.storage.create({
      name: "sandbox-cache",
      files: { "cache/value": "preserved" },
    });
    const { runtime } = await harness.provider.resolve();

    const globalStorage = await runtime.storage.ensure({
      key: "sandbox-cache",
      scope: "global",
    });
    const projectStorage = await runtime.storage.ensure({
      key: "project-a/sandbox-cache",
      scope: "project",
    });

    expect(globalStorage).toEqual({ id: "sandbox-cache" });
    expect(harness.storage.find("sandbox-cache")?.files).toEqual({
      "cache/value": "preserved",
    });
    expect(projectStorage.id).toBe(
      getSandboxStorageNativeName({
        key: "project-a/sandbox-cache",
        scope: "project",
      }),
    );
    expect(projectStorage.id).not.toBe(globalStorage.id);
  });

  test.each(["global", "project"] as const)(
    "finds existing %s storage without creating missing storage",
    async (scope) => {
      const harness = createStatefulContainerRuntimeHarness();
      const { runtime } = await harness.provider.resolve();
      const spec = { key: "sandbox-cache", scope };
      const existing = await runtime.storage.ensure(spec);
      const eventsBeforeLookup = harness.events().length;

      expect(await runtime.storage.find(spec)).toEqual(existing);
      expect(
        await runtime.storage.find({ key: "sandbox-absent", scope }),
      ).toBeNull();
      expect(harness.storage.all()).toHaveLength(1);
      expect(
        harness
          .events()
          .slice(eventsBeforeLookup)
          .map((event) => event.type),
      ).toEqual(["volume.exists", "volume.exists"]);
    },
  );

  test("preserves runtime lookup failures", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    const failure = new Error("storage service unavailable");
    harness.system.fail("volume.exists", failure);
    const { runtime } = await harness.provider.resolve();

    await expect(
      runtime.storage.find({ key: "sandbox-cache", scope: "global" }),
    ).rejects.toBe(failure);
    expect(harness.storage.all()).toEqual([]);
  });

  test("normalizes inspected mounts and removes by the mapped handle", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    const { runtime } = await harness.provider.resolve();
    const storage = await runtime.storage.ensure({
      key: "project-a/sandbox-work",
      scope: "project",
    });
    const container = harness.instances.create({
      name: "consumer",
      image: "sha256:image",
      labels: {},
      status: "exited",
      mounts: [
        {
          type: "volume",
          volumeName: storage.id,
          targetPath: "/work",
          readOnly: false,
        },
      ],
    });

    expect((await runtime.instances.inspect(container.id))?.mounts).toEqual([
      {
        type: "storage",
        storage,
        targetPath: "/work",
        readOnly: false,
      },
    ]);
    await runtime.instances.remove(container.id, { force: true });
    await runtime.storage.remove(storage);
    expect(harness.storage.find(storage.id)).toBeUndefined();
  });

  test("uses stable distinct native names for storage scopes", () => {
    const globalSpec = { key: "sandbox-work", scope: "global" } as const;
    const projectSpec = {
      key: "project-a/sandbox-work",
      scope: "project",
    } as const;

    expect(getSandboxStorageNativeName(globalSpec)).toBe("sandbox-work");
    expect(getSandboxStorageNativeName(projectSpec)).toBe(
      "sandbox-storage-project-e9b33821972ada6e8a11c929c2d1e762c097a8fcf3f2051bb20ce0dfd2d12e69",
    );
    expect(getSandboxStorageNativeName(projectSpec)).not.toBe(
      getSandboxStorageNativeName({
        key: "project-b/sandbox-work",
        scope: "project",
      }),
    );
  });
});
