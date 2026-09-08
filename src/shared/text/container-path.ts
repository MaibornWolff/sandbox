import path from "node:path/posix";

export function resolveContainerPath(
  inputPath: string,
  homeDirectory: string,
): string {
  let resolvedPath = inputPath;
  if (resolvedPath === "~" || resolvedPath.startsWith("~/")) {
    resolvedPath =
      resolvedPath === "~"
        ? homeDirectory
        : path.join(homeDirectory, resolvedPath.slice(2));
  }
  if (!path.isAbsolute(resolvedPath)) {
    resolvedPath = path.join(homeDirectory, resolvedPath);
  }
  return path.normalize(resolvedPath);
}
