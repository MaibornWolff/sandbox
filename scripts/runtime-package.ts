import { chmod, cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
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
    !(segments[0] === "docker" && segments[1] === "runtime") &&
    !source.endsWith(".test.ts")
  );
}

export async function prepareRuntimePackage(options: {
  readonly repoRoot: string;
  readonly distDirectory: string;
}): Promise<void> {
  const runtimeDirectory = await mkdtemp(
    path.join(options.distDirectory, ".runtime-"),
  );
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(runtimeDirectory, { recursive: true, force: true }));

  const results = await Promise.allSettled([
    ...RUNTIME_ASSETS.map(async (entry) => {
      const destination = path.join(runtimeDirectory, entry);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(options.repoRoot, entry), destination, {
        recursive: true,
        dereference: true,
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
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  const destination = path.join(options.distDirectory, "runtime");
  await rm(destination, { recursive: true, force: true });
  // Global npm installations must be readable outside the build user account.
  await chmod(runtimeDirectory, 0o755);
  await rename(runtimeDirectory, destination);
}
