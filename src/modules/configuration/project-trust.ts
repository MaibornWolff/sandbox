import * as crypto from "node:crypto";
import * as path from "node:path";
import chalk from "chalk";
import { getHostEnvironment } from "#platform/environment/index.js";
import {
  ensureDirectory,
  listTextFilesRecursively,
  pathExists,
  readTextFile,
  writeTextFile,
} from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import { getErrorMessage } from "#shared/errors/index.js";
import type { TrustStore } from "./config.js";

type TrustReason = "no-config" | "trusted" | "no-entry" | "hash-mismatch";

interface ProjectTrustOptions {
  readonly projectRoot: string;
  readonly sandboxDir: string;
  readonly storePath: string;
  readonly mounts: readonly string[];
}

interface ProjectTrust {
  readonly trusted: boolean;
  readonly reason: TrustReason;
  approve(trustedAt: string, currentMounts: readonly string[]): void;
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
  } catch (error) {
    getLogger().warn(
      `Ignoring corrupt trust store ${chalk.dim(storePath)}: ${getErrorMessage(error)}`,
    );
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

function getTrustReason(
  options: ProjectTrustOptions,
  hash: string | null,
): TrustReason {
  if (hash === null) return "no-config";
  const entry = loadTrustStore(options.storePath).projects[options.projectRoot];
  if (!entry) return "no-entry";
  return entry.hash === hash ? "trusted" : "hash-mismatch";
}

function computeProjectTrustHash(
  sandboxDir: string,
  mounts: readonly string[],
): string | null {
  if (!pathExists(sandboxDir)) return null;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([computeDirectoryHash(sandboxDir), mounts]))
    .digest("hex");
}

export function inspectProjectTrust(
  options: ProjectTrustOptions,
): ProjectTrust {
  const hash = computeProjectTrustHash(options.sandboxDir, options.mounts);
  const reason = getTrustReason(options, hash);
  return {
    trusted: reason === "trusted" || reason === "no-config",
    reason,
    approve(trustedAt, currentMounts) {
      if (computeProjectTrustHash(options.sandboxDir, currentMounts) !== hash) {
        throw new Error(
          "Project configuration or mount access changed during approval. Run the command again to review it.",
        );
      }
      if (hash === null) return;
      const store = loadTrustStore(options.storePath);
      store.projects[options.projectRoot] = { hash, trustedAt };
      saveTrustStore(store, options.storePath);
    },
  };
}
