import { describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPublicCliBundle } from "./public-cli-bundle.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

async function runCommand(
  command: readonly string[],
  options: RunOptions = {},
): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}> {
  const process = Bun.spawn([...command], {
    cwd: options.cwd,
    env: { PATH: globalThis.process.env.PATH, ...options.env },
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

describe("public CLI bundle", () => {
  test("runs under Node from an isolated package without node_modules", async () => {
    const packageRoot = await mkdtemp(
      path.join(tmpdir(), "sandbox-cli-bundle-"),
    );
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await rm(packageRoot, { recursive: true, force: true });
      },
    };
    const outdir = path.join(packageRoot, "dist/apps/sandbox");
    const launcher = path.join(packageRoot, "bin/sandbox.js");
    await Promise.all([
      mkdir(outdir, { recursive: true }),
      mkdir(path.dirname(launcher), { recursive: true }),
      cp(path.join(repoRoot, "bin/sandbox.js"), launcher),
      cp(
        path.join(repoRoot, "templates"),
        path.join(packageRoot, "templates"),
        {
          recursive: true,
        },
      ),
      writeFile(
        path.join(packageRoot, "package.json"),
        '{"name":"@maibornwolff/sandbox","version":"9.8.7","type":"module"}\n',
      ),
    ]);

    const metafile = await buildPublicCliBundle({ repoRoot, outdir });
    const externalImports = Object.values(metafile.outputs).flatMap((output) =>
      output.imports.filter(
        (dependency) => !dependency.path.startsWith("node:"),
      ),
    );

    expect(externalImports).toEqual([]);
    const entryPoint = path.join(outdir, "main.js");
    await chmod(entryPoint, 0o644);
    expect(await runCommand([launcher, "--version"])).toEqual({
      stdout: "9.8.7\n",
      stderr: "",
      exitCode: 0,
    });

    const projectRoot = path.join(packageRoot, "project");
    const configRoot = path.join(packageRoot, "config");
    await Promise.all([
      mkdir(path.join(projectRoot, ".git"), { recursive: true }),
      mkdir(path.join(configRoot, "sandbox"), { recursive: true }),
    ]);
    await writeFile(
      path.join(configRoot, "sandbox", "config.toml"),
      `runtime = "docker"
[[allow_host_commands]]
pattern = ["tool", { regex = "safe" }]
`,
    );

    const configResult = await runCommand(["node", entryPoint, "config"], {
      cwd: projectRoot,
      env: { XDG_CONFIG_HOME: configRoot },
    });
    expect(configResult.exitCode).toBe(0);
    expect(configResult.stderr).toBe("");
    expect(configResult.stdout).toContain("Runtime: docker");
  });
});
