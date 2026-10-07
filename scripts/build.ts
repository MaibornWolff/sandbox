import { spawn } from "node:child_process";
import { chmod, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildContainerToolsBundle } from "./container-bundle.js";
import { buildPublicCliBundle } from "./public-cli-bundle.js";
import { prepareRuntimePackage } from "./runtime-package.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distDirectory = path.resolve(
  repoRoot,
  process.env.SANDBOX_BUILD_DIR ?? "dist",
);
const hostEntryPoint = path.join(distDirectory, "apps", "sandbox", "main.js");
const containerToolsDirectory = path.join(
  distDirectory,
  "apps",
  "sandbox-container-tools",
);

async function readPackageVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("package.json must contain a string version");
  }
  return packageJson.version;
}

async function compileHostApplication(): Promise<void> {
  const typescriptCli = path.join(
    repoRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        typescriptCli,
        "-p",
        path.join(repoRoot, "tsconfig.build.json"),
        "--outDir",
        distDirectory,
      ],
      {
        cwd: repoRoot,
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `TypeScript compilation terminated by signal ${signal}`
            : `TypeScript compilation failed with exit code ${code ?? 1}`,
        ),
      );
    });
  });
}

await rm(distDirectory, { recursive: true, force: true });
await compileHostApplication();
await buildPublicCliBundle({
  repoRoot,
  outdir: path.dirname(hostEntryPoint),
});
await buildContainerToolsBundle({
  repoRoot,
  outdir: containerToolsDirectory,
  version: await readPackageVersion(),
});
if (process.platform !== "win32") {
  await chmod(hostEntryPoint, 0o755);
}
await rm(path.join(repoRoot, "docker", "runtime"), {
  recursive: true,
  force: true,
});
await prepareRuntimePackage({ repoRoot, distDirectory });
