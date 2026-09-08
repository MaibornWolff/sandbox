import path from "node:path";

const ALLOWED_SOURCE_ROOTS = [
  "src/apps/sandbox-container-tools/",
  "src/modules/configuration/",
  "src/modules/network/",
  "src/modules/sandbox-settings/",
  "src/modules/storage/",
  "src/platform/clock/",
  "src/platform/container-system/",
  "src/platform/dependency-injection/",
  "src/platform/environment/",
  "src/platform/filesystem/",
  "src/platform/logging/",
  "src/platform/process/",
  "src/platform/terminal/",
  "src/shared/",
] as const;

function normalizeInputPath(repoRoot: string, inputPath: string): string {
  const absolutePath = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(repoRoot, inputPath);
  return path.relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function assertAllowedBundleInputs(
  repoRoot: string,
  metafile: Bun.BuildMetafile,
): void {
  const rejectedInputs = Object.keys(metafile.inputs)
    .map((inputPath) => normalizeInputPath(repoRoot, inputPath))
    .filter(
      (inputPath) =>
        !inputPath.startsWith("node_modules/") &&
        !ALLOWED_SOURCE_ROOTS.some((root) => inputPath.startsWith(root)),
    );

  if (rejectedInputs.length > 0) {
    throw new Error(
      `sandbox-container-tools bundle contains disallowed inputs:\n${rejectedInputs.map((input) => `  - ${input}`).join("\n")}`,
    );
  }
}

function assertNoUnresolvedExternalImports(metafile: Bun.BuildMetafile): void {
  const externalImports = Object.entries(metafile.outputs).flatMap(
    ([outputPath, output]) =>
      output.imports
        .filter((imported) => !imported.path.startsWith("node:"))
        .map((imported) => `${outputPath}: ${imported.path}`),
  );

  if (externalImports.length > 0) {
    throw new Error(
      `sandbox-container-tools bundle contains unresolved external imports:\n${externalImports.map((imported) => `  - ${imported}`).join("\n")}`,
    );
  }
}

export async function buildContainerToolsBundle(options: {
  readonly repoRoot: string;
  readonly outdir: string;
  readonly version: string;
}): Promise<Bun.BuildMetafile> {
  const result = await Bun.build({
    entrypoints: [
      path.join(
        options.repoRoot,
        "src",
        "apps",
        "sandbox-container-tools",
        "main.ts",
      ),
    ],
    outdir: options.outdir,
    target: "node",
    format: "esm",
    packages: "bundle",
    sourcemap: "none",
    metafile: true,
    define: {
      SANDBOX_CONTAINER_TOOLS_VERSION: JSON.stringify(options.version),
    },
  });

  if (!result.success) {
    throw new Error(
      `sandbox-container-tools bundle failed:\n${result.logs.map((log) => log.message).join("\n")}`,
    );
  }
  if (!result.metafile) {
    throw new Error("sandbox-container-tools build did not produce a metafile");
  }

  assertAllowedBundleInputs(options.repoRoot, result.metafile);
  assertNoUnresolvedExternalImports(result.metafile);
  return result.metafile;
}
