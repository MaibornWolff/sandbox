import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createStatefulContainerRuntimeHarness } from "#platform/container-runtime/__test__/index.js";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { SANDBOX_RUNTIME_LABEL } from "./runtime-cache.js";
import {
  cleanupSandboxRuntimeAfterSession,
  cleanupSandboxRuntimeCache,
} from "./runtime-cleanup.js";
import { acquireRuntimeCacheLease } from "./runtime-coordination.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function createCacheDirectory(
  root: string,
  id: string,
  modifiedAt: number,
): void {
  const directory = path.join(root, "data", "sandbox", "runtime", id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "runtime.js"), id);
  const date = new Date(modifiedAt);
  utimesSync(directory, date, date);
}

test("removes only old runtime caches not assigned to any container", async () => {
  const root = createTestDir("runtime-cleanup");
  using cleanup = new DisposableStack();
  cleanup.defer(() => cleanupTestDir(root));
  const now = Date.UTC(2026, 0, 1);
  const old = now - 2 * 24 * 60 * 60 * 1_000;
  const current = `1.72.0-${HASH_A}`;
  const running = `1.71.0-${HASH_B}`;
  const stopped = `1.70.0-${HASH_C}`;
  const unused = `1.69.0-${HASH_D}`;
  const recent = `1.68.0-${"e".repeat(64)}`;
  const leased = `1.67.0-${"f".repeat(64)}`;
  for (const id of [current, running, stopped, unused, leased]) {
    createCacheDirectory(root, id, old);
  }
  createCacheDirectory(root, recent, now);
  createCacheDirectory(root, "unrelated", old);

  const harness = createStatefulContainerRuntimeHarness();
  harness.instances.create({
    name: "running",
    image: "image",
    labels: { [SANDBOX_RUNTIME_LABEL]: running },
    status: "running",
  });
  harness.instances.create({
    name: "stopped",
    image: "image",
    labels: { [SANDBOX_RUNTIME_LABEL]: stopped },
    status: "exited",
  });

  await runInHostTestScope({ root }, async () => {
    const runtime = (await harness.provider.resolve()).runtime;
    const lease = await acquireRuntimeCacheLease(leased);
    await cleanupSandboxRuntimeCache(runtime, {
      currentRuntimeId: current,
      policy: "immediate",
    });
    expect(
      await Bun.file(
        path.join(root, "data", "sandbox", "runtime", leased, "runtime.js"),
      ).exists(),
    ).toBe(true);
    await lease[Symbol.asyncDispose]();
    await cleanupSandboxRuntimeCache(runtime, {
      currentRuntimeId: current,
      policy: "immediate",
    });
  });

  const cacheRoot = path.join(root, "data", "sandbox", "runtime");
  expect(
    Bun.file(path.join(cacheRoot, current, "runtime.js")).size,
  ).toBeGreaterThan(0);
  expect(
    Bun.file(path.join(cacheRoot, running, "runtime.js")).size,
  ).toBeGreaterThan(0);
  expect(
    Bun.file(path.join(cacheRoot, stopped, "runtime.js")).size,
  ).toBeGreaterThan(0);
  expect(
    Bun.file(path.join(cacheRoot, recent, "runtime.js")).size,
  ).toBeGreaterThan(0);
  expect(
    Bun.file(path.join(cacheRoot, "unrelated", "runtime.js")).size,
  ).toBeGreaterThan(0);
  expect(
    await Bun.file(path.join(cacheRoot, unused, "runtime.js")).exists(),
  ).toBe(false);
  expect(
    await Bun.file(path.join(cacheRoot, leased, "runtime.js")).exists(),
  ).toBe(false);
});

test("scheduled cleanup observes its interval and immediate cleanup bypasses it", async () => {
  const root = createTestDir("runtime-cleanup-interval");
  using cleanup = new DisposableStack();
  cleanup.defer(() => cleanupTestDir(root));
  const now = Date.UTC(2026, 0, 1);
  const current = `1.72.0-${HASH_A}`;
  const unused = `1.69.0-${HASH_D}`;
  createCacheDirectory(root, unused, now - 2 * 24 * 60 * 60 * 1_000);
  const harness = createStatefulContainerRuntimeHarness();

  await runInHostTestScope({ root }, async () => {
    const runtime = (await harness.provider.resolve()).runtime;
    await cleanupSandboxRuntimeCache(runtime, {
      currentRuntimeId: current,
      policy: "scheduled",
    });
    createCacheDirectory(root, unused, now - 2 * 24 * 60 * 60 * 1_000);
    await cleanupSandboxRuntimeCache(runtime, {
      currentRuntimeId: current,
      policy: "scheduled",
    });
    expect(
      harness.events().filter((event) => event.type === "container.list"),
    ).toHaveLength(1);
    await cleanupSandboxRuntimeCache(runtime, {
      currentRuntimeId: current,
      policy: "immediate",
    });
  });

  expect(
    harness.events().filter((event) => event.type === "container.list"),
  ).toHaveLength(2);
  expect(
    await Bun.file(
      path.join(root, "data", "sandbox", "runtime", unused, "runtime.js"),
    ).exists(),
  ).toBe(false);
});

test("after-session cleanup does not replace the command result", async () => {
  const root = createTestDir("runtime-cleanup-best-effort");
  using cleanup = new DisposableStack();
  cleanup.defer(() => cleanupTestDir(root));
  const harness = createStatefulContainerRuntimeHarness();

  await runInHostTestScope({ root }, async () => {
    writeFileSync(path.join(root, "data", "sandbox"), "not-a-directory");
    const scheduled = cleanupSandboxRuntimeAfterSession(
      (await harness.provider.resolve()).runtime,
      `1.72.0-${HASH_A}`,
    );
    await expect(scheduled[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });
});

test("container discovery failure preserves caches and permits a retry", async () => {
  const root = createTestDir("runtime-cleanup-failure");
  using cleanup = new DisposableStack();
  cleanup.defer(() => cleanupTestDir(root));
  const now = Date.UTC(2026, 0, 1);
  const current = `1.72.0-${HASH_A}`;
  const unused = `1.69.0-${HASH_D}`;
  createCacheDirectory(root, unused, now - 2 * 24 * 60 * 60 * 1_000);
  const harness = createStatefulContainerRuntimeHarness();
  harness.system.fail("container.list", new Error("runtime unavailable"));

  await runInHostTestScope({ root }, async () => {
    const runtime = (await harness.provider.resolve()).runtime;
    await cleanupSandboxRuntimeCache(runtime, {
      currentRuntimeId: current,
      policy: "scheduled",
    });
    await cleanupSandboxRuntimeCache(runtime, {
      currentRuntimeId: current,
      policy: "scheduled",
    });
  });

  expect(
    harness.events().filter((event) => event.type === "container.list"),
  ).toHaveLength(1);
  expect(
    await Bun.file(
      path.join(root, "data", "sandbox", "runtime", unused, "runtime.js"),
    ).exists(),
  ).toBe(false);
});
