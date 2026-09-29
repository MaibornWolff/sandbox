import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createHostEnvironment,
  provideHostEnvironment,
} from "#platform/environment/index.js";
import { runWithCapturedLogs } from "#test/captured-logger.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  computeDirectoryHash,
  getTrustStorePath,
  isProjectTrusted,
  loadTrustStore,
  saveTrustStore,
  trustProject,
} from "./project-trust.js";

const trustedAt = "2026-01-01T00:00:00.000Z";

describe("project trust", () => {
  test("resolves the trust store from the scoped host environment", () => {
    const environment = createHostEnvironment({
      currentWorkingDirectory: "/project",
      homeDirectory: "/home/test",
      variables: { SANDBOX_CONFIG_DIR: "/config" },
      platform: "linux",
      interactive: false,
    });
    expect(
      runWithDependencies(
        [provideHostEnvironment(environment)],
        getTrustStorePath,
      ),
    ).toBe(path.join("/config", "trusted-projects.json"));
  });

  test("loads empty stores for missing, malformed, and structurally invalid files", () => {
    const root = createTestDir("trust-load");
    const storePath = path.join(root, "trusted-projects.json");
    try {
      expect(loadTrustStore(storePath)).toEqual({ version: 1, projects: {} });
      fs.writeFileSync(storePath, "not json");
      const messages: string[] = [];
      expect(
        runWithCapturedLogs(messages, () => loadTrustStore(storePath)),
      ).toEqual({ version: 1, projects: {} });
      expect(messages.join("\n")).toContain("Ignoring corrupt trust store");
      fs.writeFileSync(storePath, '{"version":1}');
      expect(loadTrustStore(storePath)).toEqual({ version: 1, projects: {} });
    } finally {
      cleanupTestDir(root);
    }
  });

  test("serializes trust stores and creates parent directories", () => {
    const root = createTestDir("trust-save");
    const storePath = path.join(root, "nested", "trusted-projects.json");
    try {
      saveTrustStore(
        { version: 1, projects: { "/project": { hash: "abc", trustedAt } } },
        storePath,
      );
      expect(loadTrustStore(storePath).projects["/project"]).toEqual({
        hash: "abc",
        trustedAt,
      });
    } finally {
      cleanupTestDir(root);
    }
  });

  test("hashes sorted nested file names and contents deterministically", () => {
    const first = createTestDir("trust-hash-first");
    const second = createTestDir("trust-hash-second");
    try {
      fs.mkdirSync(path.join(first, "nested"));
      fs.mkdirSync(path.join(second, "nested"));
      fs.writeFileSync(path.join(first, "z.txt"), "z");
      fs.writeFileSync(path.join(first, "nested", "a.txt"), "a");
      fs.writeFileSync(path.join(second, "nested", "a.txt"), "a");
      fs.writeFileSync(path.join(second, "z.txt"), "z");
      expect(computeDirectoryHash(first)).toBe(computeDirectoryHash(second));
      fs.writeFileSync(path.join(second, "z.txt"), "changed");
      expect(computeDirectoryHash(first)).not.toBe(
        computeDirectoryHash(second),
      );
    } finally {
      cleanupTestDir(first);
      cleanupTestDir(second);
    }
  });

  test("distinguishes absent config, unknown project, trusted content, and changed content", () => {
    const root = createTestDir("trust-status");
    const sandboxDir = path.join(root, ".sandbox");
    const storePath = path.join(root, "store.json");
    try {
      expect(isProjectTrusted(root, sandboxDir, storePath)).toEqual({
        trusted: true,
        reason: "no-config",
      });
      fs.mkdirSync(sandboxDir);
      fs.writeFileSync(
        path.join(sandboxDir, "config.toml"),
        "readonly = false\n",
      );
      expect(isProjectTrusted(root, sandboxDir, storePath)).toEqual({
        trusted: false,
        reason: "no-entry",
      });
      trustProject(root, sandboxDir, storePath, trustedAt);
      expect(isProjectTrusted(root, sandboxDir, storePath)).toEqual({
        trusted: true,
        reason: "trusted",
      });
      fs.writeFileSync(
        path.join(sandboxDir, "config.toml"),
        "readonly = true\n",
      );
      expect(isProjectTrusted(root, sandboxDir, storePath)).toEqual({
        trusted: false,
        reason: "hash-mismatch",
      });
      expect(loadTrustStore(storePath).projects[root]?.trustedAt).toBe(
        trustedAt,
      );
    } finally {
      cleanupTestDir(root);
    }
  });
});
