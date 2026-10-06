import { describe, expect, test } from "bun:test";
import { createStatefulContainerRuntimeHarness } from "#platform/container-runtime/__test__/index.js";
import type { SandboxRuntime } from "#platform/container-runtime/index.js";
import { readState, writeState } from "#platform/state/index.js";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  ensureRuntimeStorage,
  removeRuntimeStorage,
} from "./runtime-storage.js";

async function withStorage(
  action: (fixture: {
    runtime: SandboxRuntime;
    harness: ReturnType<typeof createStatefulContainerRuntimeHarness>;
  }) => Promise<void>,
): Promise<void> {
  const root = createTestDir("runtime-storage");
  using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
  const harness = createStatefulContainerRuntimeHarness();
  const { runtime } = await harness.provider.resolve();
  await runInHostTestScope({ root }, () => action({ runtime, harness }));
}

const globalSpec = { key: "sandbox-cache", scope: "global" } as const;

describe("runtime storage ownership", () => {
  test("records the runtime handle returned by ensure", async () => {
    await withStorage(async ({ runtime, harness }) => {
      const storage = await ensureRuntimeStorage(runtime, {
        key: "project-a/sandbox-work",
        scope: "project",
      });

      expect(readState().sandboxStorage).toEqual({
        "docker/project/project-a/sandbox-work": storage,
      });
      expect(harness.storage.find(storage.id)).toBeDefined();
      expect(storage.id).not.toBe("project-a/sandbox-work");
    });
  });

  test("removes the recorded handle without looking up or creating storage", async () => {
    await withStorage(async ({ runtime, harness }) => {
      harness.storage.create({ name: "opaque-recorded-handle" });
      writeState({
        sandboxStorage: {
          "docker/global/sandbox-cache": { id: "opaque-recorded-handle" },
          "podman/global/sandbox-cache": { id: "other-runtime-handle" },
        },
      });

      expect(await removeRuntimeStorage(runtime, globalSpec)).toBe(true);
      expect(harness.storage.find("opaque-recorded-handle")).toBeUndefined();
      expect(harness.events()).toEqual([
        { type: "volume.remove", name: "opaque-recorded-handle" },
      ]);
      expect(readState().sandboxStorage).toEqual({
        "podman/global/sandbox-cache": { id: "other-runtime-handle" },
      });
    });
  });

  test("keeps recorded storage when removal is refused", async () => {
    await withStorage(async ({ runtime, harness }) => {
      await ensureRuntimeStorage(runtime, globalSpec);
      harness.instances.create({
        name: "consumer",
        image: "sha256:image",
        labels: {},
        status: "running",
        mounts: [
          {
            type: "volume",
            volumeName: "sandbox-cache",
            targetPath: "/cache",
            readOnly: false,
          },
        ],
      });

      await expect(removeRuntimeStorage(runtime, globalSpec)).rejects.toThrow(
        "referenced by container",
      );
      expect(readState().sandboxStorage).toEqual({
        "docker/global/sandbox-cache": { id: "sandbox-cache" },
      });
      expect(harness.storage.find("sandbox-cache")).toBeDefined();
    });
  });

  test("finds and removes unrecorded current-name global storage without creating it", async () => {
    await withStorage(async ({ runtime, harness }) => {
      harness.storage.create({ name: "sandbox-cache" });

      expect(await removeRuntimeStorage(runtime, globalSpec)).toBe(true);
      expect(harness.events()).toEqual([
        { type: "volume.exists", name: "sandbox-cache" },
        { type: "volume.remove", name: "sandbox-cache" },
      ]);
      expect(harness.storage.all()).toEqual([]);
    });
  });

  test("does nothing for absent global and unrecorded project storage", async () => {
    await withStorage(async ({ runtime, harness }) => {
      expect(await removeRuntimeStorage(runtime, globalSpec)).toBe(false);
      expect(
        await removeRuntimeStorage(runtime, {
          key: "project-a/sandbox-work",
          scope: "project",
        }),
      ).toBe(false);
      expect(harness.events()).toEqual([
        { type: "volume.exists", name: "sandbox-cache" },
      ]);
      expect(harness.storage.all()).toEqual([]);
    });
  });

  test("reports failed lookup without removing or creating storage", async () => {
    await withStorage(async ({ runtime, harness }) => {
      const failure = new Error("storage service unavailable");
      harness.system.fail("volume.exists", failure);
      harness.storage.create({ name: "sandbox-cache" });

      await expect(removeRuntimeStorage(runtime, globalSpec)).rejects.toBe(
        failure,
      );
      expect(harness.storage.find("sandbox-cache")).toBeDefined();
      expect(harness.events()).toEqual([]);
    });
  });
});
