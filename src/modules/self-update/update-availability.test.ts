import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createNpmFixture } from "#platform/npm/__test__/index.js";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  formatAvailableUpdateWarning,
  warnIfUpdateAvailable,
} from "./update-availability.js";

const packageName = "@maibornwolff/sandbox";

describe("update availability", () => {
  it("formats only a newer cached release", () => {
    expect(formatAvailableUpdateWarning("1.0.0", null)).toBeNull();
    expect(formatAvailableUpdateWarning("1.0.0", "1.0.0")).toBeNull();
    expect(formatAvailableUpdateWarning("1.0.0", "0.9.0")).toBeNull();
    expect(
      formatAvailableUpdateWarning("0.0.0-development", "2.0.0"),
    ).toBeNull();
    const warning = formatAvailableUpdateWarning("1.0.0", "2.0.0");
    expect(warning).toContain("Sandbox update available");
    expect(warning).toContain("1.0.0");
    expect(warning).toContain("2.0.0");
    expect(warning).toContain("sandbox update");
  });

  it("refreshes and preserves cache state without a real wait", async () => {
    const root = createTestDir("update-check");
    try {
      const statePath = path.join(root, "data", "sandbox", "state.json");
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify({ templateHashes: { config: "keep" } }),
      );
      const scoped = await runInHostTestScope(
        { root },
        async ({ processes }) => {
          const npm = createNpmFixture(processes);
          npm.givenPackageVersion(packageName, "1.5.0");
          npm.prepare();
          await warnIfUpdateAvailable();
          return npm.operations();
        },
      );
      const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
        latestVersion?: string;
        latestVersionCheckedAt?: number;
        templateHashes?: Record<string, string>;
      };
      expect(scoped.result).toEqual([{ type: "version.lookup", packageName }]);
      expect(state).toMatchObject({
        latestVersion: "1.5.0",
        latestVersionCheckedAt: Date.UTC(2026, 0, 1),
        templateHashes: { config: "keep" },
      });
    } finally {
      cleanupTestDir(root);
    }
  });

  it("uses a fresh cache and silently settles registry failures", async () => {
    const root = createTestDir("update-cache");
    try {
      const statePath = path.join(root, "data", "sandbox", "state.json");
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          latestVersion: "1.5.0",
          latestVersionCheckedAt: Date.UTC(2026, 0, 1),
        }),
      );
      const cached = await runInHostTestScope(
        { root, verbose: true },
        async ({ processes }) => {
          const npm = createNpmFixture(processes);
          npm.failRegistry(packageName);
          await warnIfUpdateAvailable();
          return npm.operations();
        },
      );
      expect(cached.result).toEqual([]);
      expect(cached.stderr).toContain("Using cached Sandbox update check");

      fs.writeFileSync(statePath, JSON.stringify({ latestVersion: "1.0.0" }));
      const failed = await runInHostTestScope(
        { root, verbose: true },
        async ({ processes }) => {
          const npm = createNpmFixture(processes);
          npm.failRegistry(packageName);
          npm.prepare();
          await warnIfUpdateAvailable();
        },
      );
      expect(failed.stderr).toContain("Sandbox update check failed");
    } finally {
      cleanupTestDir(root);
    }
  });
});
