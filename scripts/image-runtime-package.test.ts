import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getRepoRootPath } from "#platform/git/index.js";
import { buildContainerToolsBundle } from "./container-bundle.js";
import { prepareImageRuntimePackage } from "./image-runtime-package.js";
import { buildPublicCliBundle } from "./public-cli-bundle.js";

test("prepares a self-contained image package and replaces stale runtime files", async () => {
  const repoRoot = await getRepoRootPath(process.cwd());
  const root = await mkdtemp(path.join(tmpdir(), "image-runtime-package-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "test", "source");
  const distDirectory = path.join(root, "dist");
  const contextDirectory = path.join(root, "docker");
  const runtimeDirectory = path.join(contextDirectory, "runtime");

  for (const entry of ["bin", "templates", "docs", "docker"]) {
    await cp(path.join(repoRoot, entry), path.join(source, entry), {
      recursive: true,
      filter: (file) => file !== path.join(repoRoot, "docker", "runtime"),
    });
  }
  await mkdir(path.join(source, "src", "test"), { recursive: true });
  await writeFile(path.join(source, "src", "feature.ts"), "export {};\n");
  await writeFile(path.join(source, "src", "feature.test.ts"), "test\n");
  await writeFile(path.join(source, "src", "test", "fixture.ts"), "test\n");
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "@maibornwolff/sandbox",
      version: "9.8.7",
      type: "module",
    }),
  );
  await cp(path.join(repoRoot, "README.md"), path.join(source, "README.md"));
  await buildPublicCliBundle({
    repoRoot,
    outdir: path.join(distDirectory, "apps", "sandbox"),
  });
  await buildContainerToolsBundle({
    repoRoot,
    outdir: path.join(distDirectory, "apps", "sandbox-container-tools"),
    version: "9.8.7",
  });

  const options = { repoRoot: source, distDirectory, contextDirectory };
  await prepareImageRuntimePackage(options);
  await writeFile(path.join(runtimeDirectory, "stale-file"), "obsolete");
  await prepareImageRuntimePackage(options);
  expect(existsSync(path.join(runtimeDirectory, "stale-file"))).toBe(false);
  expect(existsSync(path.join(runtimeDirectory, "node_modules"))).toBe(false);
  expect(existsSync(path.join(runtimeDirectory, "src/feature.test.ts"))).toBe(
    false,
  );
  expect(existsSync(path.join(runtimeDirectory, "src/test"))).toBe(false);
  expect(
    await readFile(path.join(runtimeDirectory, "src/feature.ts"), "utf8"),
  ).toBe("export {};\n");

  for (const app of ["sandbox", "sandbox-container-tools"]) {
    const child = Bun.spawn(
      [
        "node",
        path.join(runtimeDirectory, "dist/apps", app, "main.js"),
        "--version",
      ],
      { cwd: runtimeDirectory, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: "9.8.7\n",
      stderr: "",
      exitCode: 0,
    });
  }
});
