import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { getClock, provideClock } from "#platform/clock/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  getHostEnvironment,
  provideHostEnvironment,
} from "#platform/environment/index.js";
import { createNpmFixture } from "#platform/npm/__test__/index.js";
import {
  claimUpdateRefresh,
  readState,
  readUpdateCache,
  writeState,
} from "#platform/state/index.js";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  formatAvailableUpdateWarning,
  runUpdateCheckWorker,
  warnIfUpdateAvailable,
} from "./update-availability.js";

const packageName = "@maibornwolff/sandbox";
const hour = 60 * 60 * 1_000;

function withNode<T>(callback: () => T): T {
  return runWithDependencies(
    [
      provideHostEnvironment({
        ...getHostEnvironment(),
        executablePath: "/node",
      }),
    ],
    callback,
  );
}

function token(): string {
  const value = claimUpdateRefresh(getClock().now());
  if (value === undefined) throw new Error("Expected a refresh claim");
  return value;
}

describe("update availability", () => {
  it("formats only a newer cached release", () => {
    expect(formatAvailableUpdateWarning("1.0.0", null)).toBeNull();
    expect(formatAvailableUpdateWarning("1.0.0", "1.0.0")).toBeNull();
    expect(formatAvailableUpdateWarning("1.0.0", "0.9.0")).toBeNull();
    expect(
      formatAvailableUpdateWarning("0.0.0-development", "2.0.0"),
    ).toBeNull();
    expect(formatAvailableUpdateWarning("1.0.0", "2.0.0")).toContain(
      "sandbox update",
    );
  });

  it("returns immediately and leaves a pending detached worker alive at shutdown", async () => {
    const root = createTestDir("update-no-wait");
    using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
    await runInHostTestScope({ root }, async ({ processes }) => {
      const worker = processes.expectStart({ match: { command: "/node" } });
      expect(withNode(warnIfUpdateAvailable)).toBeUndefined();
      expect(await worker.waitForStart()).toMatchObject({
        detached: true,
        stdio: "ignore",
      });
      await processes.manager.dispose();
      expect(worker.signals).toEqual([]);
      expect(processes.requests).toHaveLength(1);
      worker.exit();
    });
  });

  it("refreshes only in the worker and never changes unrelated state", async () => {
    const root = createTestDir("update-worker");
    using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
    const scope = await runInHostTestScope({ root }, async ({ processes }) => {
      writeState({ templateHashes: { config: "keep" } });
      const worker = processes.expectStart({ match: { command: "/node" } });
      withNode(warnIfUpdateAvailable);
      const request = await worker.waitForStart();
      const claim = request.args?.[2] ?? "";
      const npm = createNpmFixture(processes);
      npm.givenPackageVersion(packageName, "1.5.0");
      npm.prepare();
      await runUpdateCheckWorker(claim);
      await runUpdateCheckWorker(claim);
      expect(readUpdateCache().latestVersion).toBe("1.5.0");
      expect(npm.operations()).toHaveLength(1);
      writeState({ sandboxStorage: { project: { id: "new-storage" } } });
      expect(readState()).toEqual({
        templateHashes: { config: "keep" },
        sandboxStorage: { project: { id: "new-storage" } },
      });
      withNode(warnIfUpdateAvailable);
      expect(processes.requests).toHaveLength(2);
      worker.exit();
    });
    expect(scope.stderr).not.toContain("Sandbox update available");
  });

  it("backs off failed attempts and preserves the last available release", async () => {
    const root = createTestDir("update-failure");
    using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
    await runInHostTestScope({ root }, async ({ processes }) => {
      const clock = createTestClock(Date.UTC(2026, 0, 1));
      await runWithDependencies([provideClock(clock.clock)], async () => {
        const npm = createNpmFixture(processes);
        npm.givenPackageVersion(packageName, "2.0.0");
        npm.prepare();
        await runUpdateCheckWorker(token());
        await clock.advanceBy(24 * hour);
        npm.failRegistry(packageName);
        npm.prepare();
        await runUpdateCheckWorker(token());
        expect(readUpdateCache()).toMatchObject({
          latestVersion: "2.0.0",
          error: "Failed to check for updates: npm ERR! code ENETUNREACH",
        });
        expect(claimUpdateRefresh(clock.currentTime())).toBeUndefined();
        await clock.advanceBy(hour);
        expect(claimUpdateRefresh(clock.currentTime())).toBeUndefined();
        await clock.advanceBy(hour);
        expect(claimUpdateRefresh(clock.currentTime())).toBeDefined();
      });
    });
  });

  it.each(["SIGTERM", "SIGKILL"] as const)(
    "bounds a stalled npm process that exits on %s",
    async (signal) => {
      const root = createTestDir("update-timeout");
      using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
      await runInHostTestScope({ root }, async ({ processes }) => {
        const clock = createTestClock(Date.UTC(2026, 0, 1));
        await runWithDependencies([provideClock(clock.clock)], async () => {
          const npm = processes.expectStart({ match: { command: "npm" } });
          npm.exitOnSignal(signal);
          const refresh = runUpdateCheckWorker(token());
          await npm.waitForStart();
          await clock.advanceBy(15_000);
          await npm.waitForSignal();
          if (signal === "SIGKILL") await clock.advanceBy(1_000);
          await refresh;
          expect(npm.signals).toEqual(
            signal === "SIGTERM" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"],
          );
          expect(readUpdateCache().error).toBe(
            "Failed to check for updates: npm update check timed out",
          );
          expect(claimUpdateRefresh(clock.currentTime())).toBeUndefined();
        });
      });
    },
  );

  it("records asynchronous launch errors without blocking or retrying", async () => {
    const root = createTestDir("update-spawn-error");
    using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
    await runInHostTestScope({ root }, async ({ processes }) => {
      const worker = processes.expectStart({ match: { command: "/node" } });
      withNode(warnIfUpdateAvailable);
      worker.rejectResult(new Error("spawn ENOENT"));
      await Promise.resolve();
      expect(readUpdateCache().error).toBe("spawn ENOENT");
      withNode(warnIfUpdateAvailable);
      expect(processes.requests).toHaveLength(1);
    });
  });

  it("records failed launches and retries abandoned claims after backoff", async () => {
    const root = createTestDir("update-launch-error");
    using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
    const scope = await runInHostTestScope(
      { root, verbose: true },
      async () => {
        warnIfUpdateAvailable();
        expect(readUpdateCache().error).toBe(
          "Node executable path is unavailable",
        );
        warnIfUpdateAvailable();
        const now = getClock().now();
        const claim = claimUpdateRefresh(now + 2 * hour);
        expect(claim).toBeDefined();
        expect(claimUpdateRefresh(now + 2 * hour)).toBeUndefined();
        await runUpdateCheckWorker("../bad-token");
        await runUpdateCheckWorker("0");
        expect(
          fs
            .readdirSync(path.join(root, "data", "sandbox", "update-check"))
            .filter((name) => name.startsWith("attempt-")),
        ).toHaveLength(1);
      },
    );
    expect(scope.stderr).toContain("Previous Sandbox update check failed");
  });
});
