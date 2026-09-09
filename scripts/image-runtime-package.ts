import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const RUNTIME_ASSETS = [
  "bin",
  "package.json",
  "README.md",
  "docs",
  "templates",
  "src",
  "docker/Dockerfile",
  "docker/configs",
  "docker/scripts",
] as const;

function includeRuntimeAsset(source: string): boolean {
  const segments = source.split(path.sep);
  return (
    !segments.includes("__test__") &&
    !segments.includes("test") &&
    !source.endsWith(".test.ts")
  );
}

export async function prepareImageRuntimePackage(options: {
  readonly repoRoot: string;
  readonly distDirectory: string;
  readonly contextDirectory: string;
}): Promise<void> {
  const runtimeDirectory = path.join(options.contextDirectory, "runtime");
  await rm(runtimeDirectory, { recursive: true, force: true });
  await mkdir(runtimeDirectory, { recursive: true });

  await Promise.all([
    ...RUNTIME_ASSETS.map(async (entry) => {
      const destination = path.join(runtimeDirectory, entry);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(options.repoRoot, entry), destination, {
        recursive: true,
        filter: (source) =>
          includeRuntimeAsset(path.relative(options.repoRoot, source)),
      });
    }),
    ...["sandbox", "sandbox-container-tools"].map(async (app) => {
      const entry = path.join("apps", app, "main.js");
      const destination = path.join(runtimeDirectory, "dist", entry);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(options.distDirectory, entry), destination);
    }),
  ]);
}
