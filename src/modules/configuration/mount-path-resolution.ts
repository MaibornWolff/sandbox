import * as path from "node:path";
import * as pathPosix from "node:path/posix";
import { getHostEnvironment } from "#platform/environment/index.js";
import { pathExists, realPathOrSelf } from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import {
  safeResolve,
  splitColonString,
  windowsPathToDocker,
} from "#shared/text/index.js";
import { formatConfigPath } from "./config-path-display.js";
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
    `Skipping mount because source path does not exist: ${formatConfigPath(sourcePath ?? "(empty)")}`,
  );
  return false;
}

/**
 * Resolve multiple mounts and filter out ones with non-existent sources
 */
export function resolveExistingMounts(
  mounts: readonly string[],
  projectDir: string,
  isProjectConfig: boolean,
): string[] {
  return mounts
    .map((m) => resolveMount(m, projectDir, isProjectConfig))
    .filter(mountSourceExists);
}

/**
 * Resolve project sources from the project root, and other sources from the working directory.
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

  const baseDirectory = isProjectConfig
    ? projectDir
    : getHostEnvironment().currentWorkingDirectory;
  const resolvedPath = safeResolve(srcPath, baseDirectory);
  getLogger().debug(
    `Resolved ${isProjectConfig ? "project " : ""}mount: ${formatConfigPath(srcPath)} → ${formatConfigPath(resolvedPath)}`,
  );

  const inputParts = splitColonString(mountStr);
  const usesDefaultDestination =
    inputParts.length === 1 ||
    (inputParts.length === 2 &&
      (inputParts[1] === "ro" || inputParts[1] === "rw"));
  if (usesDefaultDestination && !pathPosix.isAbsolute(parts[1] ?? "")) {
    parts[1] = windowsPathToDocker(resolvedPath);
  }

  // Container runtimes on macOS need the real host path.
  parts[0] = realPathOrSelf(resolvedPath);
  return parseMount(parts.join(":"));
}
