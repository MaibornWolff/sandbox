import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Config, PersistPath } from "#modules/configuration/index.js";
import { createConfigFromDefaults } from "#modules/configuration/index.js";
import { getRepoRootPath } from "#platform/git/index.js";

const TEST_TMP_BASE = path.join(tmpdir(), "sandbox-tests");

export async function getTestRepoRootPath(): Promise<string> {
  return getRepoRootPath(process.cwd());
}

export function stripAnsi(value: string): string {
  const ansiEscape = String.fromCharCode(27);
  return value.replace(
    new RegExp(`${ansiEscape}\\[[0-?]*[ -/]*[@-~]`, "g"),
    "",
  );
}

/**
 * Create a temporary directory for tests
 * Uses a stable base and a unique directory for parallel isolation.
 */
export function createTestDir(prefix: string): string {
  fs.mkdirSync(TEST_TMP_BASE, { recursive: true });
  return fs.mkdtempSync(path.join(TEST_TMP_BASE, `${prefix}-`));
}

/**
 * Clean up a test directory
 */
export function cleanupTestDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Create a test config with sensible defaults and optional overrides
 */
export function createTestConfig(overrides?: Partial<Config>): Config {
  return createConfigFromDefaults("docker", overrides);
}

/**
 * Helper to create a PersistPath from a string
 */
export function createPersistPath(
  pathStr: string,
  opts?: { global?: boolean; default?: string; onlyIfExists?: boolean },
): PersistPath {
  return {
    path: pathStr,
    global: opts?.global ?? false,
    default: opts?.default,
    onlyIfExists: opts?.onlyIfExists ?? false,
  };
}
