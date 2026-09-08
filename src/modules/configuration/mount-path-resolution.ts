import * as path from "node:path";
import * as pathPosix from "node:path/posix";
import chalk from "chalk";
import { getHostEnvironment } from "#platform/environment/index.js";
import {
  pathExists,
  realPathOrSelf,
  validateSymlinkWithin,
} from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import {
  normalizePath,
  safeResolve,
  splitColonString,
} from "#shared/text/index.js";
import { parseMount } from "./config-value-parsing.js";

const CONTAINER_HOME = "/home/sandbox";

/** @testonly */
export function expandTildeInMount(
  mount: string,
  hostHomeDirectory: string,
): string {
  const parts = splitColonString(mount);
  if (!parts[0]) return mount;

  if (parts[0] === "~") {
    parts[0] = hostHomeDirectory;
  } else if (parts[0].startsWith("~/")) {
    parts[0] = path.join(hostHomeDirectory, parts[0].slice(2));
  }

  if (parts[1] === "~") {
    parts[1] = CONTAINER_HOME;
  } else if (parts[1]?.startsWith("~/")) {
    parts[1] = pathPosix.join(CONTAINER_HOME, parts[1].slice(2));
  }

  return parts.join(":");
}

/**
 * Check if a mount's source path exists
 */
function mountSourceExists(mount: string): boolean {
  const sourcePath = splitColonString(mount)[0];
  if (sourcePath && pathExists(sourcePath)) return true;

  getLogger().warn(
    `Skipping mount because source path does not exist: ${chalk.dim(sourcePath ?? "(empty)")}`,
  );
  return false;
}

/**
 * Resolve multiple mounts and filter out ones with non-existent sources
 */
export function resolveExistingMounts(
  mounts: string[],
  projectDir: string,
  isProjectConfig: boolean,
): string[] {
  return mounts
    .map((m) => resolveMount(m, projectDir, isProjectConfig))
    .filter(mountSourceExists);
}

/**
 * Resolve mount path and validate for project config
 * @testonly
 */
export function resolveMount(
  mountStr: string,
  projectDir: string,
  isProjectConfig: boolean,
): string {
  // First normalize shorthand (e.g., "~/.npmrc" → "~/.npmrc:~/.npmrc:ro")
  // Then expand ~ so both sides get proper expansion
  const normalizedMountStr = parseMount(mountStr);
  const expandedMountStr = expandTildeInMount(
    normalizedMountStr,
    getHostEnvironment().homeDirectory,
  );

  const parts = splitColonString(expandedMountStr);
  const srcPath = parts[0];

  if (!srcPath) {
    throw new Error("Invalid mount string: empty source path");
  }

  // For project config, validate security restrictions
  if (isProjectConfig) {
    // Resolve to absolute path - safeResolve handles Windows drive paths
    // correctly in Git Bash (path.resolve alone treats them as relative)
    const resolvedPath = safeResolve(srcPath, projectDir);
    getLogger().debug(`Resolved project mount: ${srcPath} → ${resolvedPath}`);

    // SECURITY: Ensure resolved path stays within project directory
    const normalizedResolved = normalizePath(resolvedPath);
    const normalizedProject = normalizePath(path.resolve(projectDir));
    if (
      !normalizedResolved.startsWith(`${normalizedProject}/`) &&
      normalizedResolved !== normalizedProject
    ) {
      getLogger().debug(
        `Rejecting path outside project directory: ${srcPath} → ${resolvedPath}`,
      );
      throw new Error(
        `Project config cannot mount paths outside project: ${srcPath}`,
      );
    }

    // Additional symlink validation
    validateSymlinkWithin(resolvedPath, projectDir);

    // Resolve symlinks so Docker runtimes on macOS get the real path
    const realPath = realPathOrSelf(resolvedPath);

    // Rebuild mount string with resolved path
    parts[0] = realPath;
    return parseMount(parts.join(":"));
  }

  // For global config or CLI, resolve to absolute path
  // safeResolve handles Windows drive paths correctly in Git Bash
  const resolvedPath = safeResolve(srcPath);
  getLogger().debug(`Resolved mount: ${srcPath} → ${resolvedPath}`);

  // Resolve symlinks so Docker runtimes on macOS get the real path
  const realPath = realPathOrSelf(resolvedPath);

  parts[0] = realPath;
  return parseMount(parts.join(":"));
}
