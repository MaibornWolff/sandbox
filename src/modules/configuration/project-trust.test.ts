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
  inspectProjectTrust,
  loadTrustStore,
  saveTrustStore,
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

  test("does not approve changes made after the trust inspection", () => {
    const root = createTestDir("trust-reviewed-snapshot");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const sandboxDir = path.join(root, ".sandbox");
    const storePath = path.join(root, "store.json");
    fs.mkdirSync(sandboxDir);
    const configPath = path.join(sandboxDir, "config.toml");
    fs.writeFileSync(configPath, 'mounts = ["/data/reference"]\n');
    const options = {
      projectRoot: root,
      sandboxDir,
      storePath,
      mounts: ["/data/reference:/reference:ro"],
    };
    const approval = inspectProjectTrust(options);
    fs.writeFileSync(configPath, 'mounts = ["/data/secrets:rw"]\n');
    expect(() => approval.approve(trustedAt, options.mounts)).toThrow(
      "Project configuration or mount access changed during approval.",
    );
    expect(fs.existsSync(storePath)).toBe(false);
  });

  test.each([
    ["source", ["/data/other:/reference:ro"]],
    ["destination", ["/data/reference:/other:ro"]],
    ["mode", ["/data/reference:/reference:rw"]],
    [
      "newly available source",
      ["/data/reference:/reference:ro", "/data/extra:/extra:ro"],
    ],
  ])("requires approval when resolved mount %s changes", (_change, mounts) => {
    const root = createTestDir("trust-mount-access");
    using cleanup = new DisposableStack();
    cleanup.defer(() => cleanupTestDir(root));
    const sandboxDir = path.join(root, ".sandbox");
    const storePath = path.join(root, "store.json");
    fs.mkdirSync(sandboxDir);
    const options = {
      projectRoot: root,
      sandboxDir,
      storePath,
      mounts: ["/data/reference:/reference:ro"],
    };
    inspectProjectTrust(options).approve(trustedAt, options.mounts);
    expect(inspectProjectTrust({ ...options, mounts })).toMatchObject({
      trusted: false,
      reason: "hash-mismatch",
    });
  });

  test("distinguishes absent config, unknown project, trusted content, and changed content", () => {
    const root = createTestDir("trust-status");
    const sandboxDir = path.join(root, ".sandbox");
    const storePath = path.join(root, "store.json");
    try {
      const options = { projectRoot: root, sandboxDir, storePath, mounts: [] };
      const absent = inspectProjectTrust(options);
      expect(absent).toMatchObject({
        trusted: true,
        reason: "no-config",
      });
      absent.approve(trustedAt, options.mounts);
      expect(fs.existsSync(storePath)).toBe(false);
      fs.mkdirSync(sandboxDir);
      fs.writeFileSync(
        path.join(sandboxDir, "config.toml"),
        "readonly = false\n",
      );
      const approval = inspectProjectTrust(options);
      expect(approval).toMatchObject({
        trusted: false,
        reason: "no-entry",
      });
      approval.approve(trustedAt, options.mounts);
      expect(inspectProjectTrust(options)).toMatchObject({
        trusted: true,
        reason: "trusted",
      });
      fs.writeFileSync(
        path.join(sandboxDir, "config.toml"),
        "readonly = true\n",
      );
      expect(inspectProjectTrust(options)).toMatchObject({
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
