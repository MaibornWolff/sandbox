import * as path from "node:path";
import { getHostEnvironment } from "#platform/environment/index.js";
import { generateProjectSlug } from "#shared/text/index.js";

export function getGlobalPersistDir(): string {
  return path.join(getHostEnvironment().dataHomeDirectory, "sandbox", "global");
}

export function getProjectPersistDir(projectPath: string): string {
  return path.join(
    getHostEnvironment().dataHomeDirectory,
    "sandbox",
    generateProjectSlug(projectPath),
  );
}
