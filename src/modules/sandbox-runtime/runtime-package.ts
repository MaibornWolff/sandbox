import path from "node:path";
import {
  getPackageRootPath,
  getPathType,
  hashDirectoryContents,
  readJsonRecord,
} from "#platform/filesystem/index.js";

export interface RuntimePackage {
  readonly directory: string;
  readonly version: string;
}

export interface IdentifiedRuntimePackage extends RuntimePackage {
  readonly contentHash: string;
}

function readRuntimeVersion(directory: string): string {
  const value = readJsonRecord(path.join(directory, "package.json")).version;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Sandbox runtime package has no version: ${directory}`);
  }
  return value;
}

export function readRuntimePackage(
  directory = path.join(getPackageRootPath(), "dist", "runtime"),
): IdentifiedRuntimePackage {
  const programs = ["sandbox", "sandbox-container-tools"];
  const complete = programs.every(
    (program) =>
      getPathType(path.join(directory, "dist", "apps", program, "main.js")) ===
      "file",
  );
  if (!complete) {
    throw new Error(
      `Sandbox runtime package is missing from ${directory}. Reinstall Sandbox or run bun run build in the source checkout.`,
    );
  }
  return {
    directory,
    version: readRuntimeVersion(directory),
    contentHash: hashDirectoryContents(directory),
  };
}
