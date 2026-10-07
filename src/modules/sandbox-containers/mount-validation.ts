import { posix, win32 } from "node:path";
import { getHostEnvironment } from "#platform/environment/index.js";
import { realPathOrSelf } from "#platform/filesystem/index.js";

export function validateProtectedMountPaths(
  protectedPath: string,
  destinations: readonly string[],
): void {
  const root = posix.normalize(protectedPath).replace(/\/$/, "");
  for (const destination of destinations) {
    const normalized = posix
      .normalize(destination.replaceAll("\\", "/"))
      .replace(/\/$/, "");
    if (
      normalized === root ||
      normalized.startsWith(`${root}/`) ||
      root.startsWith(`${normalized}/`)
    ) {
      throw new Error(
        `Mount destination ${destination} overlaps the managed Sandbox runtime at ${protectedPath}. Choose another destination.`,
      );
    }
  }
}

function getPathImplementation() {
  return getHostEnvironment().platform === "win32" ? win32 : posix;
}

/**
 * Get platform-specific blocklist of system directories that should not be mounted
 */
function getSystemPathBlocklist(): string[] {
  const environment = getHostEnvironment();
  const pathImplementation = getPathImplementation();
  const commonPaths = [
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib32",
    "/lib64",
    "/sys",
    "/proc",
    "/dev",
    "/boot",
    "/root",
    "/docker",
    "/run",
  ];

  if (environment.platform === "darwin") {
    return [
      ...commonPaths,
      "/System",
      "/Library",
      "/private/etc",
      "/Applications",
    ];
  }

  if (environment.platform === "win32") {
    const appData = environment.variables.APPDATA ?? "";
    const localAppData = environment.variables.LOCALAPPDATA ?? "";
    return [
      "C:\\Windows",
      "C:\\Program Files",
      "C:\\Program Files (x86)",
      "C:\\ProgramData",
      appData,
      localAppData,
      pathImplementation.join(environment.homeDirectory, "AppData"),
    ].filter(Boolean);
  }

  return commonPaths;
}

/**
 * Check if a path is a system path that should not be mounted
 */
function isSystemPath(path: string): boolean {
  const pathImplementation = getPathImplementation();
  const normalizedPath = pathImplementation.normalize(path);
  const blocklist = getSystemPathBlocklist();

  return blocklist.some(
    (blockedPath) =>
      normalizedPath === blockedPath ||
      normalizedPath.startsWith(blockedPath + pathImplementation.sep),
  );
}

/**
 * Validate that a path is safe to mount (not a system directory)
 * Throws error with helpful message if path is in blocklist
 */
export function validateMountPath(containerPath: string): void {
  const pathImplementation = getPathImplementation();
  const normalizedPath = pathImplementation.normalize(containerPath);
  const resolvedPath = pathImplementation.normalize(
    realPathOrSelf(containerPath),
  );

  // Block filesystem root
  if (
    normalizedPath === pathImplementation.parse(normalizedPath).root ||
    resolvedPath === pathImplementation.parse(resolvedPath).root ||
    normalizedPath === "\\" ||
    resolvedPath === "\\"
  ) {
    throw new Error(
      "Cannot mount filesystem root.\n\n" +
        "Mounting the entire filesystem is not allowed for security.\n" +
        "Try running from a user directory (e.g., ~/projects/).",
    );
  }

  // Check both normalized path and resolved path (handles symlinks)
  // For example, on macOS /etc is a symlink to /private/etc
  const pathsToCheck =
    resolvedPath !== normalizedPath
      ? [normalizedPath, resolvedPath]
      : [normalizedPath];

  for (const pathToCheck of pathsToCheck) {
    if (isSystemPath(pathToCheck)) {
      throw new Error(
        `Cannot mount system directory: ${pathToCheck}\n\n` +
          "System directories are blocked for security.\n" +
          "Try running from a user directory (e.g., ~/projects/) or use --mount to add specific system paths.",
      );
    }
  }
}
