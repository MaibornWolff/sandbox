import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cleanupTestDir,
  createTestDir,
  getTestRepoRootPath,
} from "#test/utils.js";

const projectTestDirectories: string[] = [];
const isolatedDirectories: string[] = [];

afterEach(async () => {
  for (const directory of projectTestDirectories.splice(0)) {
    cleanupTestDir(directory);
  }
  await Promise.all(
    isolatedDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function runNode(
  entryPoint: string,
  argument: "--help" | "--version",
): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}> {
  const process = Bun.spawn(["node", entryPoint, argument], {
    cwd: path.dirname(entryPoint),
    env: { PATH: globalThis.process.env.PATH },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("sandbox-container-tools bundle", () => {
  test("runs under Node from an isolated ESM package without node_modules", async () => {
    const repoRoot = await getTestRepoRootPath();
    const buildDirectory = createTestDir("container-tools-build");
    projectTestDirectories.push(buildDirectory);
    const result = await Bun.build({
      entrypoints: [
        path.join(
          repoRoot,
          "src",
          "apps",
          "sandbox-container-tools",
          "main.ts",
        ),
      ],
      outdir: buildDirectory,
      target: "node",
      format: "esm",
      packages: "bundle",
      sourcemap: "none",
      metafile: true,
      define: { SANDBOX_CONTAINER_TOOLS_VERSION: JSON.stringify("9.8.7") },
    });

    expect(result.success).toBe(true);
    expect(result.metafile).toBeDefined();
    const metafileInputs = result.metafile?.inputs ?? {};
    const inputs = Object.keys(metafileInputs).map((input) =>
      input.replaceAll("\\", "/"),
    );
    const productionApplication = Object.entries(metafileInputs).find(
      ([input]) =>
        input
          .replaceAll("\\", "/")
          .endsWith("/sandbox-container-tools/production-application.ts"),
    )?.[1];
    const application = Object.entries(metafileInputs).find(([input]) =>
      input
        .replaceAll("\\", "/")
        .endsWith("/sandbox-container-tools/application.ts"),
    )?.[1];
    const createProgram = Object.entries(metafileInputs).find(([input]) =>
      input
        .replaceAll("\\", "/")
        .endsWith("/sandbox-container-tools/create-program.ts"),
    )?.[1];
    expect(
      productionApplication?.imports.some((dependency) =>
        dependency.path
          .replaceAll("\\", "/")
          .endsWith("/sandbox-container-tools/application.ts"),
      ),
    ).toBe(true);
    expect(
      application?.imports.some((dependency) =>
        dependency.path
          .replaceAll("\\", "/")
          .endsWith("/sandbox-container-tools/create-program.ts"),
      ),
    ).toBe(true);
    expect(
      createProgram?.imports.some((dependency) =>
        dependency.path
          .replaceAll("\\", "/")
          .endsWith("/sandbox-container-tools/entrypoint.ts"),
      ),
    ).toBe(true);
    expect(
      inputs.some((input) => input.includes("node_modules/commander/")),
    ).toBe(true);
    expect(
      inputs.some((input) =>
        input.endsWith("/sandbox-container-tools/entrypoint.ts"),
      ),
    ).toBe(true);
    expect(inputs.some((input) => input.includes("src/apps/sandbox/"))).toBe(
      false,
    );
    expect(
      inputs.some((input) => input.includes("platform/container-runtime/")),
    ).toBe(false);
    expect(
      inputs.some((input) => input.includes("modules/sandbox-images/")),
    ).toBe(false);
    expect(
      inputs.some((input) => input.includes("modules/sandbox-containers/")),
    ).toBe(false);
    const nonNodeExternals = Object.values(
      result.metafile?.outputs ?? {},
    ).flatMap((output) =>
      output.imports.filter((imported) => !imported.path.startsWith("node:")),
    );
    expect(nonNodeExternals).toEqual([]);

    const isolatedDirectory = await mkdtemp(
      path.join(tmpdir(), "sandbox-container-tools-"),
    );
    isolatedDirectories.push(isolatedDirectory);
    const isolatedEntryPoint = path.join(isolatedDirectory, "main.js");
    await Promise.all([
      cp(path.join(buildDirectory, "main.js"), isolatedEntryPoint),
      writeFile(
        path.join(isolatedDirectory, "package.json"),
        '{"type":"module"}\n',
      ),
      mkdir(path.join(isolatedDirectory, "empty-home")),
    ]);

    const version = await runNode(isolatedEntryPoint, "--version");
    expect(version).toEqual({ stdout: "9.8.7\n", stderr: "", exitCode: 0 });
    const help = await runNode(isolatedEntryPoint, "--help");
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("sandbox-container-tools");
  });
});
