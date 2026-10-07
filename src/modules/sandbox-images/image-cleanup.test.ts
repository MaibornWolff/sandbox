import { describe, expect, test } from "bun:test";
import { createStatefulContainerRuntimeHarness } from "#platform/container-runtime/__test__/index.js";
import type { SandboxRuntimeSelection } from "#platform/container-runtime/index.js";
import { readState, writeState } from "#platform/state/index.js";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { formatImageSize, removeUnusedManagedImages } from "./image-cleanup.js";

async function withRuntime<T>(
  callback: (
    harness: ReturnType<typeof createStatefulContainerRuntimeHarness>,
    runtime: SandboxRuntimeSelection,
  ) => Promise<T>,
): Promise<T> {
  using cleanup = new DisposableStack();
  const root = createTestDir("image-cleanup");
  cleanup.defer(() => cleanupTestDir(root));
  const harness = createStatefulContainerRuntimeHarness();
  const runtime = await harness.provider.resolve();
  return (await runInHostTestScope({ root }, () => callback(harness, runtime)))
    .result;
}

describe("removeUnusedManagedImages", () => {
  test("removes only unused managed images and reports estimated space", async () => {
    await withRuntime(async (harness, runtime) => {
      harness.images.create({
        id: "unused",
        labels: { "sandbox.managed": "true" },
        dangling: true,
        size: 1_500_000,
      });
      harness.images.create({
        id: "used",
        labels: { "sandbox.managed": "true" },
        dangling: true,
        size: 2_000_000,
      });
      harness.images.create({
        id: "unmanaged",
        dangling: true,
        size: 5_000_000,
      });
      writeState({
        sandboxImages: {
          "docker:unused": { reference: "unused", digest: "unused" },
          "docker:used": { reference: "used", digest: "used" },
          "docker:unmanaged": {
            reference: "unmanaged",
            digest: "unmanaged",
          },
        },
      });
      harness.instances.create({
        name: "consumer",
        image: "used",
        labels: {},
        status: "running",
      });

      await expect(removeUnusedManagedImages(runtime)).resolves.toEqual({
        removed: 1,
        freedSpace: "1.5MB",
      });
      expect(harness.images.find("unused")).toBeUndefined();
      expect(harness.images.find("used")).toBeDefined();
      expect(harness.images.find("unmanaged")).toBeDefined();
    });
  });

  test("preserves ownership records after removal failures", async () => {
    await withRuntime(async (harness, runtime) => {
      harness.images.create({
        id: "failed",
        labels: { "sandbox.managed": "true" },
        dangling: true,
      });
      writeState({
        sandboxImages: {
          "docker:current": {
            reference: "current",
            digest: "current",
            ownedDigests: ["failed"],
          },
        },
      });
      harness.system.fail("image.remove", new Error("runtime conflict"));

      await expect(removeUnusedManagedImages(runtime)).rejects.toThrow(
        "runtime conflict",
      );
      expect(harness.images.find("failed")).toBeDefined();
      expect(
        readState().sandboxImages?.["docker:current"]?.ownedDigests,
      ).toEqual(["failed"]);
    });
  });

  test("preserves ownership records for retained images", async () => {
    await withRuntime(async (harness, runtime) => {
      harness.images.create({
        id: "retained",
        references: ["retained:latest"],
        labels: { "sandbox.managed": "true" },
      });
      writeState({
        sandboxImages: {
          "docker:current": {
            reference: "current",
            digest: "current",
            ownedDigests: ["retained"],
          },
        },
      });

      await expect(removeUnusedManagedImages(runtime)).resolves.toEqual({
        removed: 0,
        freedSpace: "0B",
      });
      expect(
        readState().sandboxImages?.["docker:current"]?.ownedDigests,
      ).toEqual(["retained"]);
    });
  });

  test("does not delete another runtime's equal digest metadata", async () => {
    await withRuntime(async (harness, runtime) => {
      harness.images.create({
        id: "shared-digest",
        labels: { "sandbox.managed": "true" },
        dangling: true,
      });
      writeState({
        sandboxImages: {
          "docker:selected": {
            reference: "selected",
            digest: "shared-digest",
          },
          "podman:other": {
            reference: "other",
            digest: "shared-digest",
          },
        },
      });

      await removeUnusedManagedImages(runtime);

      expect(readState().sandboxImages).toEqual({
        "podman:other": {
          reference: "other",
          digest: "shared-digest",
        },
      });
    });
  });

  test("does not evaluate images that are not recorded as candidates", async () => {
    await withRuntime(async (harness, runtime) => {
      harness.images.create({
        id: "unrecorded",
        labels: { "sandbox.managed": "true" },
        dangling: true,
      });
      await expect(removeUnusedManagedImages(runtime)).resolves.toEqual({
        removed: 0,
        freedSpace: "0B",
      });
      expect(harness.images.find("unrecorded")).toBeDefined();
    });
  });
});

describe("formatImageSize", () => {
  test("formats byte ranges and decimal precision", () => {
    expect(formatImageSize(0)).toBe("0B");
    expect(formatImageSize(5)).toBe("5B");
    expect(formatImageSize(500)).toBe("500.0B");
    expect(formatImageSize(1_200)).toBe("1.2KB");
    expect(formatImageSize(15_000)).toBe("15.0KB");
    expect(formatImageSize(1_500_000)).toBe("1.5MB");
    expect(formatImageSize(2_500_000_000)).toBe("2.5GB");
    expect(formatImageSize(1_000_000_000_000)).toBe("1TB");
  });
});
