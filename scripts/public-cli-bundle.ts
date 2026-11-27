import { readFile } from "node:fs/promises";
import path from "node:path";

/** Native addons stay in node_modules, so the CLI can load the binary for the host platform. */
const NATIVE_PACKAGES = ["@crosscopy/clipboard"];

function assertNoUnresolvedExternalImports(metafile: Bun.BuildMetafile): void {
  const externalImports = Object.entries(metafile.outputs).flatMap(
    ([outputPath, output]) =>
      output.imports
        .filter(
          (dependency) =>
            !dependency.path.startsWith("node:") &&
            !NATIVE_PACKAGES.includes(dependency.path),
        )
        .map((dependency) => `${outputPath}: ${dependency.path}`),
  );
  if (externalImports.length === 0) return;

  throw new Error(
    `Public CLI bundle contains unresolved external imports:\n${externalImports.map((dependency) => `  - ${dependency}`).join("\n")}`,
  );
}

async function createRe2WasmPlugin(repoRoot: string): Promise<Bun.BunPlugin> {
  const packageRoot = path.join(repoRoot, "node_modules", "re2-wasm", "build");
  const wasm = await readFile(path.join(packageRoot, "wasm", "re2.wasm"));
  const wasmBase64 = wasm.toString("base64");
  const initialization =
    "var wasmBinary;if (Module['wasmBinary']) wasmBinary = Module['wasmBinary'];";
  const embeddedInitialization = `var wasmBinary = Uint8Array.from(Buffer.from("${wasmBase64}", "base64"));if (Module['wasmBinary']) wasmBinary = Module['wasmBinary'];`;

  return {
    name: "embed-re2-wasm",
    setup(build) {
      build.onLoad(
        { filter: /re2-wasm[\\/]build[\\/]wasm[\\/]re2\.js$/ },
        async ({ path: modulePath }) => {
          const source = await readFile(modulePath, "utf8");
          if (!source.includes(initialization)) {
            throw new Error(
              "The re2-wasm bundle does not contain the expected initialization code.",
            );
          }
          return {
            contents: source.replace(initialization, embeddedInitialization),
            loader: "js",
          };
        },
      );
    },
  };
}

export async function buildPublicCliBundle(options: {
  readonly repoRoot: string;
  readonly outdir: string;
}): Promise<Bun.BuildMetafile> {
  const result = await Bun.build({
    entrypoints: [
      path.join(options.repoRoot, "src", "apps", "sandbox", "main.ts"),
    ],
    outdir: options.outdir,
    target: "node",
    format: "esm",
    packages: "bundle",
    external: NATIVE_PACKAGES,
    sourcemap: "none",
    metafile: true,
    plugins: [await createRe2WasmPlugin(options.repoRoot)],
  });

  if (!result.success) {
    throw new Error(
      `Public CLI bundle failed:\n${result.logs.map((log) => log.message).join("\n")}`,
    );
  }
  if (!result.metafile) {
    throw new Error("Public CLI bundle did not produce a metafile");
  }
  assertNoUnresolvedExternalImports(result.metafile);
  return result.metafile;
}
