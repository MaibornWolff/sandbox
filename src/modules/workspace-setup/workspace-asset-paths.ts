import * as path from "node:path";
import { getPackageRootPath } from "#platform/filesystem/index.js";

export function getTemplatesDirectory(
  packageRoot: string = getPackageRootPath(),
): string {
  return path.join(packageRoot, "templates");
}

export function getToolRegistryPath(
  packageRoot: string = getPackageRootPath(),
): string {
  return path.join(
    packageRoot,
    "src",
    "modules",
    "workspace-setup",
    "tools",
    "tool-registry.ts",
  );
}
