import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { readState, writeState } from "./index.js";
import {
  claimUpdateRefresh,
  finishUpdateRefresh,
  readUpdateCache,
  startUpdateRefresh,
} from "./update-cache.js";

const now = Date.UTC(2026, 0, 1);
const hour = 60 * 60 * 1_000;

test("migrates the existing available release without writing shared state", async () => {
  const root = createTestDir("update-cache-migration");
  using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
  await runInHostTestScope({ root }, () => {
    const existing = {
      latestVersion: "2.0.0",
      latestVersionCheckedAt: now - 24 * hour,
      sandboxImages: { project: { reference: "image", digest: "digest" } },
    };
    writeState(existing);
    expect(readUpdateCache().latestVersion).toBe("2.0.0");
    const token = claimUpdateRefresh(now);
    expect(token).toBeDefined();
    finishUpdateRefresh(token ?? "", now, { error: "registry unavailable" });
    expect(readUpdateCache()).toMatchObject({
      latestVersion: "2.0.0",
      error: "registry unavailable",
    });
    expect(readState()).toEqual(existing);
  });
});

test("rejects stale worker claims and late results", async () => {
  const root = createTestDir("update-cache-stale");
  using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
  await runInHostTestScope({ root }, () => {
    const first = claimUpdateRefresh(now) ?? "";
    const nextTime = now + 2 * hour;
    const second = claimUpdateRefresh(nextTime) ?? "";
    expect(startUpdateRefresh(first, nextTime)).toBe(false);
    expect(startUpdateRefresh(second, nextTime)).toBe(true);
    finishUpdateRefresh(second, nextTime, { latestVersion: "2.0.0" });
    finishUpdateRefresh(first, nextTime, { latestVersion: "1.0.0" });
    expect(readUpdateCache().latestVersion).toBe("2.0.0");
  });
});

test("grants only one claim and one worker for overlapping requests", async () => {
  const root = createTestDir("update-cache-claims");
  using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
  await runInHostTestScope({ root }, async () => {
    const claims = await Promise.all(
      Array.from({ length: 8 }, async () => claimUpdateRefresh(now)),
    );
    const granted = claims.filter((token) => token !== undefined);
    expect(granted).toHaveLength(1);
    const token = granted[0] ?? "";
    expect(startUpdateRefresh(token, now)).toBe(true);
    expect(startUpdateRefresh(token, now)).toBe(false);
  });
});

test.each(["../outside", "-1", "NaN", "9007199254740999", "99999999", "0"])(
  "rejects invalid or expired worker token %s without changing a cached notice",
  async (token) => {
    const root = createTestDir("update-cache-invalid");
    using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
    await runInHostTestScope({ root }, () => {
      const claim = claimUpdateRefresh(now) ?? "";
      finishUpdateRefresh(claim, now, { latestVersion: "2.0.0" });
      expect(startUpdateRefresh(token, now)).toBe(false);
      finishUpdateRefresh(token, now, { error: "must not replace success" });
      expect(readUpdateCache()).toEqual({
        latestVersion: "2.0.0",
        checkedAt: now,
      });
    });
  },
);

test("reports cache write errors without altering shared state", async () => {
  const root = createTestDir("update-cache-write-failure");
  using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
  await runInHostTestScope({ root }, () => {
    writeState({ templateHashes: { config: "keep" } });
    const token = claimUpdateRefresh(now) ?? "";
    fs.mkdirSync(
      path.join(root, "data", "sandbox", "update-check", "cache.json"),
    );
    expect(() =>
      finishUpdateRefresh(token, now, { latestVersion: "2.0.0" }),
    ).toThrow();
    expect(readState()).toEqual({ templateHashes: { config: "keep" } });
  });
});

test("recovers from malformed cache records", async () => {
  const root = createTestDir("update-cache-corrupt");
  using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
  await runInHostTestScope({ root }, () => {
    const directory = path.join(root, "data", "sandbox", "update-check");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "cache.json"),
      JSON.stringify({ latestVersion: 42 }),
    );
    expect(readUpdateCache()).toEqual({});
    expect(claimUpdateRefresh(now)).toBeDefined();
  });
});
