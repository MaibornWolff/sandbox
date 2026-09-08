import * as path from "node:path";
import { getPackageRootPath } from "#platform/filesystem/index.js";

export function getDockerBuildContextDirectory(
  packageRoot: string = getPackageRootPath(),
): string {
  return path.join(packageRoot, "docker");
}
