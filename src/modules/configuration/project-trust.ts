import * as crypto from "node:crypto";
import * as path from "node:path";
import { getHostEnvironment } from "#platform/environment/index.js";
import {
  ensureDirectory,
  listTextFilesRecursively,
  pathExists,
  readTextFile,
  writeTextFile,
} from "#platform/filesystem/index.js";
import type { TrustStore } from "./config.js";

type TrustReason = "no-config" | "trusted" | "no-entry" | "hash-mismatch";

interface TrustResult {
  trusted: boolean;
  reason: TrustReason;
}

/** @testonly */
export function getTrustStorePath(): string {
  const environment = getHostEnvironment();
  const sandboxConfigDirectory =
    environment.variables.SANDBOX_CONFIG_DIR ??
    path.join(environment.configHomeDirectory, "sandbox");
  return path.join(sandboxConfigDirectory, "trusted-projects.json");
}

/** @testonly */
export function loadTrustStore(storePath: string): TrustStore {
  if (!pathExists(storePath)) return { version: 1, projects: {} };
  try {
    const parsed: unknown = JSON.parse(readTextFile(storePath));
    if (parsed && typeof parsed === "object" && "projects" in parsed) {
      return parsed as TrustStore;
    }
  } catch {
    // A corrupt optional trust store is treated as empty.
  }
  return { version: 1, projects: {} };
}

/** @testonly */
export function saveTrustStore(store: TrustStore, storePath: string): void {
  ensureDirectory(path.dirname(storePath));
  writeTextFile(storePath, JSON.stringify(store, null, 2));
}

/** @testonly */
export function computeDirectoryHash(dirPath: string): string {
  const files = listTextFilesRecursively(dirPath).sort((first, second) =>
    first.relativePath.localeCompare(second.relativePath),
  );
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.content);
  }
  return hash.digest("hex");
}

export function isProjectTrusted(
  projectRoot: string,
  sandboxDir: string,
  storePath: string,
): TrustResult {
  if (!pathExists(sandboxDir)) return { trusted: true, reason: "no-config" };
  const entry = loadTrustStore(storePath).projects[projectRoot];
  if (!entry) return { trusted: false, reason: "no-entry" };
  if (entry.hash !== computeDirectoryHash(sandboxDir)) {
    return { trusted: false, reason: "hash-mismatch" };
  }
  return { trusted: true, reason: "trusted" };
}

export function trustProject(
  projectRoot: string,
  sandboxDir: string,
  storePath: string,
  trustedAt: string,
): void {
  const store = loadTrustStore(storePath);
  store.projects[projectRoot] = {
    hash: computeDirectoryHash(sandboxDir),
    trustedAt,
  };
  saveTrustStore(store, storePath);
}
