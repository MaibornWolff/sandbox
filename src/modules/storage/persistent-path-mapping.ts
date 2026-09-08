import * as path from "node:path";
import * as pathPosix from "node:path/posix";
import { getHostEnvironment } from "#platform/environment/index.js";
import { getLogger } from "#platform/logging/index.js";
import { resolveContainerPath } from "#shared/text/index.js";

/**
 * Container home directory
 */
const CONTAINER_HOME = "/home/sandbox";

/**
 * Resolve a persist path configuration to host and container paths.
 *
 * Input formats:
 * - ~/.foo       → hostPath in persist storage, containerPath: /home/sandbox/.foo
 * - ./foo        → hostPath in persist storage/workdir/, containerPath: {projectPath}/foo
 * - /home/sandbox/foo → hostPath in persist storage, containerPath: /home/sandbox/foo
 *
 * @returns Object with hostPath and containerPath, or null if invalid
 */
interface ResolvedPersistentPaths {
  hostPath: string;
  containerPath: string;
  persistSubPath: string;
  originHostPath: string;
}

export function resolvePersistentPaths(
  persistPath: string,
  containerProjectPath: string,
  persistBaseDir: string,
  projectPath: string,
): ResolvedPersistentPaths | null {
  const homeDirectory = getHostEnvironment().homeDirectory;
  const logger = getLogger();
  // Home-relative: ~/.foo
  if (persistPath.startsWith("~/")) {
    const relativePath = persistPath.slice(2); // Remove ~/
    return {
      hostPath: path.join(persistBaseDir, relativePath),
      containerPath: resolveContainerPath(persistPath, CONTAINER_HOME),
      persistSubPath: relativePath,
      originHostPath: path.join(homeDirectory, relativePath),
    };
  }

  // Just ~ means home directory itself (not supported)
  if (persistPath === "~") {
    logger.debug("Persist: skipping ~ (cannot persist entire home directory)");
    return null;
  }

  // Project-relative: ./foo
  if (persistPath.startsWith("./")) {
    const relativePath = persistPath.slice(2); // Remove ./
    // Store under workdir/ prefix in persist storage to avoid conflicts
    return {
      hostPath: path.join(persistBaseDir, "workdir", relativePath),
      containerPath: pathPosix.join(containerProjectPath, relativePath),
      persistSubPath: `workdir/${relativePath}`,
      originHostPath: path.join(projectPath, relativePath),
    };
  }

  // Absolute path under container home
  if (persistPath.startsWith(`${CONTAINER_HOME}/`)) {
    const relativePath = persistPath.slice(CONTAINER_HOME.length + 1);
    return {
      hostPath: path.join(persistBaseDir, relativePath),
      containerPath: persistPath,
      persistSubPath: relativePath,
      originHostPath: path.join(homeDirectory, relativePath),
    };
  }

  // Absolute path at container home exactly
  if (persistPath === CONTAINER_HOME) {
    logger.debug(
      "Persist: skipping /home/sandbox (cannot persist entire home directory)",
    );
    return null;
  }

  // Other absolute paths outside home
  if (persistPath.startsWith("/")) {
    logger.debug(
      `Persist: skipping ${persistPath} (absolute path outside container home)`,
    );
    return null;
  }

  // Invalid format - bare paths not supported
  logger.debug(
    `Persist: skipping ${persistPath} (invalid format - must start with ~/, ./, or /)`,
  );
  return null;
}
