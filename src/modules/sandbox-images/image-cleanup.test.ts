import { describe, expect, test } from "bun:test";
import { createStatefulContainerRuntimeHarness } from "#platform/container-runtime/__test__/index.js";
import type { ContainerRuntime } from "#platform/container-runtime/index.js";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { formatImageSize, removeDanglingImages } from "./image-cleanup.js";

async function withRuntime<T>(
  callback: (
    harness: ReturnType<typeof createStatefulContainerRuntimeHarness>,
    runtime: ContainerRuntime,
  ) => Promise<T>,
): Promise<T> {
  const root = createTestDir("image-cleanup");
  const harness = createStatefulContainerRuntimeHarness();
  const runtime = await harness.provider.resolve();
  try {
    return (
      await runInHostTestScope({ root }, () => callback(harness, runtime))
    ).result;
  } finally {
    cleanupTestDir(root);
  }
}

describe("removeDanglingImages", () => {
  test("removes unused images and reports freed space", async () => {
    await withRuntime(async (harness, runtime) => {
      harness.images.create({
        id: "unused",
        dangling: true,
        size: 1_500_000,
        created: "today",
      });
      harness.images.create({
        id: "used",
        dangling: true,
        size: 2_000_000,
        created: "today",
      });
      harness.containers.create({
        name: "consumer",
        image: "used",
        labels: {},
        status: "running",
      });

      await expect(removeDanglingImages(runtime)).resolves.toEqual({
        removed: 1,
        freedSpace: "1.5MB",
      });
      expect(harness.images.find("unused")).toBeUndefined();
      expect(harness.images.find("used")).toBeDefined();
    });
  });

  test("continues when one image cannot be removed", async () => {
    await withRuntime(async (harness, runtime) => {
      harness.images.create({ id: "failed", dangling: true, size: 1_000 });
      harness.images.create({ id: "removed", dangling: true, size: 2_000 });
      harness.system.fail("image.remove", new Error("in use"));

      await expect(removeDanglingImages(runtime)).resolves.toEqual({
        removed: 1,
        freedSpace: "2KB",
      });
      expect(harness.images.find("failed")).toBeDefined();
      expect(harness.images.find("removed")).toBeUndefined();
    });
  });

  test("treats failed image queries as empty", async () => {
    await withRuntime(async (harness, runtime) => {
      harness.system.fail(
        "image.dangling.list",
        new Error("runtime unavailable"),
      );
      await expect(removeDanglingImages(runtime)).resolves.toEqual({
        removed: 0,
        freedSpace: "0B",
      });
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
