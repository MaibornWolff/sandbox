import * as path from "node:path";
import * as pathPosix from "node:path/posix";
import chalk from "chalk";
import { getHostEnvironment } from "#platform/environment/index.js";
import { getLogger } from "#platform/logging/index.js";
import { hasNormalizedPathSegments } from "#shared/text/index.js";

/**
 * Container home directory
 */
const CONTAINER_HOME = "/home/sandbox";

interface ResolvedPersistentPaths {
  hostPath: string;
  containerPath: string;
  persistSubPath: string;
  originHostPath: string;
}

interface PersistPathTarget {
  /** Whether the path lives below the container home or the project directory. */
  scope: "home" | "project";
  /** Path below the scope root, without the configured prefix. */
  relativePath: string;
}

/**
 * Split a persist path into its scope and the path below that scope.
 *
 * Input formats:
 * - ~/.foo            → home scope, relativePath ".foo"
 * - ./foo             → project scope, relativePath "foo"
 * - /home/sandbox/foo → home scope, relativePath "foo"
 *
 * @returns The target, or null if the path cannot be persisted
 */
function parsePersistPath(persistPath: string): PersistPathTarget | null {
  const logger = getLogger();
  if (persistPath.startsWith("~/")) {
    return { scope: "home", relativePath: persistPath.slice(2) };
  }
  if (persistPath.startsWith("./")) {
    return { scope: "project", relativePath: persistPath.slice(2) };
  }
  if (persistPath.startsWith(`${CONTAINER_HOME}/`)) {
    return {
      scope: "home",
      relativePath: persistPath.slice(CONTAINER_HOME.length + 1),
    };
  }
  if (persistPath === "~" || persistPath === CONTAINER_HOME) {
    logger.debug(
      `Persist: skipping ${persistPath} (cannot persist entire home directory)`,
    );
    return null;
  }
  if (persistPath.startsWith("/")) {
    logger.debug(
      `Persist: skipping ${persistPath} (absolute path outside container home)`,
    );
    return null;
  }
  logger.debug(
    `Persist: skipping ${persistPath} (invalid format - must start with ~/, ./, or /)`,
  );
  return null;
}

/**
 * Resolve a persist path configuration to host and container paths.
 *
 * The host path always stays strictly below `persistBaseDir`: paths with
 * ".", "..", empty, or backslash segments, or with no segment at all, are
 * skipped with a warning.
 *
 * @returns Object with hostPath and containerPath, or null if invalid
 */
export function resolvePersistentPaths(
  persistPath: string,
  containerProjectPath: string,
  persistBaseDir: string,
  projectPath: string,
): ResolvedPersistentPaths | null {
  const target = parsePersistPath(persistPath);
  if (!target) return null;
  const { scope, relativePath } = target;
  if (!hasNormalizedPathSegments(relativePath)) {
    getLogger().warn(
      `Persist: skipping ${persistPath} (path must select a location below its prefix inside persist storage ${chalk.dim(persistBaseDir)})`,
    );
    return null;
  }
  if (scope === "project") {
    // Store under workdir/ prefix in persist storage to avoid conflicts
    return {
      hostPath: path.join(persistBaseDir, "workdir", relativePath),
      containerPath: pathPosix.join(containerProjectPath, relativePath),
      persistSubPath: `workdir/${relativePath}`,
      originHostPath: path.join(projectPath, relativePath),
    };
  }
  return {
    hostPath: path.join(persistBaseDir, relativePath),
    containerPath: pathPosix.join(CONTAINER_HOME, relativePath),
    persistSubPath: relativePath,
    originHostPath: path.join(getHostEnvironment().homeDirectory, relativePath),
  };
}
