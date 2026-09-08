import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getHostEnvironment } from "#platform/environment/index.js";

const PACKAGE_NAME = "@maibornwolff/sandbox";

interface PackageRootOptions {
  packageName?: string;
  executablePath?: string;
}

function toLocalPath(location: string, executablePath: string): string {
  if (location.includes("$bunfs")) {
    return path.dirname(executablePath);
  }
  if (location.startsWith("file:")) {
    return fileURLToPath(location);
  }
  return location.replace(/\\/g, "/");
}

function startingDirectory(location: string): string {
  try {
    return fs.statSync(location).isDirectory()
      ? location
      : path.dirname(location);
  } catch {
    return path.extname(location) ? path.dirname(location) : location;
  }
}

function hasExpectedPackageName(
  packageJsonPath: string,
  packageName: string,
): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
    };
    return parsed.name === packageName;
  } catch {
    return false;
  }
}

/** @testonly */
export function findPackageRootPath(
  location: string,
  options: PackageRootOptions = {},
): string {
  const packageName = options.packageName ?? PACKAGE_NAME;
  const executablePath =
    options.executablePath ??
    (location.includes("$bunfs")
      ? (getHostEnvironment().executablePath ??
        getHostEnvironment().currentWorkingDirectory)
      : "");
  let current = path.resolve(
    startingDirectory(toLocalPath(location, executablePath)),
  );

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (hasExpectedPackageName(packageJsonPath, packageName)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(
    `Could not find package root for ${packageName} from ${location}`,
  );
}

export function getPackageRootPath(): string {
  return findPackageRootPath(import.meta.url);
}

export function readPackageVersion(): string {
  const packageJsonPath = path.join(getPackageRootPath(), "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    version: string;
  };
  return packageJson.version;
}
