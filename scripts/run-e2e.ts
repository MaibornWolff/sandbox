import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE =
  "Usage: bun scripts/run-e2e.ts [--extended] [--runtime docker|podman|apple-container] [--file NAME.test.ts] [--test-name-pattern REGEX] [--timeout MS]";

interface E2eCommand {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

interface E2eRuntimeSnapshot extends AsyncDisposable {
  readonly root: string;
  readonly binaryPath: string;
}

interface RunE2eOptions {
  readonly repoRoot: string;
  readonly suite: "core" | "extended";
  readonly runtime?: string;
  readonly file?: string;
  readonly testNamePattern?: string;
  readonly timeout?: string;
}

async function runCommand(command: E2eCommand): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [...command.args], {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function createE2eRuntimeSnapshot(
  repoRoot: string,
): Promise<E2eRuntimeSnapshot> {
  const tempRoot = path.join(repoRoot, "test-tmp");
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(path.join(tempRoot, "e2e-runtime-"));
  await Promise.all([
    chmod(root, 0o755),
    ...["docker", "templates"].map((entry) =>
      cp(path.join(repoRoot, entry), path.join(root, entry), {
        recursive: true,
      }),
    ),
    cp(path.join(repoRoot, "package.json"), path.join(root, "package.json")),
  ]).catch(async (error: unknown) => {
    await rm(root, { recursive: true, force: true });
    throw error;
  });
  const binaryPath = path.join(root, "dist", "apps", "sandbox", "main.js");

  return {
    root,
    binaryPath,
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function runE2e(options: RunE2eOptions): Promise<number> {
  await using snapshot = await createE2eRuntimeSnapshot(options.repoRoot);
  const buildExitCode = await runCommand({
    args: ["run", "build"],
    cwd: options.repoRoot,
    env: { SANDBOX_BUILD_DIR: path.join(snapshot.root, "dist") },
  });
  if (buildExitCode !== 0) return buildExitCode;

  const suitePath = options.suite === "extended" ? "e2e-extended" : "e2e";
  return await runCommand({
    args: [
      "test",
      `--timeout=${options.timeout ?? "30000"}`,
      ...(options.testNamePattern === undefined
        ? []
        : [`--test-name-pattern=${options.testNamePattern}`]),
      `./tests/${suitePath}/${options.file ?? ""}`,
    ],
    cwd: options.repoRoot,
    env: {
      ...(options.runtime === undefined
        ? {}
        : { SANDBOX_TEST_RUNTIME: options.runtime }),
      SANDBOX_BIN: snapshot.binaryPath,
      SANDBOX_RUNTIME_ROOT: snapshot.root,
      SANDBOX_E2E_EXTENDED: options.suite === "extended" ? "1" : "0",
    },
  });
}

if (import.meta.main) {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const { values } = parseArgs({
    options: {
      extended: { type: "boolean" },
      runtime: { type: "string" },
      file: { type: "string" },
      "test-name-pattern": { type: "string" },
      timeout: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(USAGE);
  } else {
    const { extended, runtime, file, timeout } = values;
    if (
      runtime !== undefined &&
      !["docker", "podman", "apple-container"].includes(runtime)
    ) {
      throw new Error(`Unsupported end-to-end test runtime: ${runtime}`);
    }
    if (file !== undefined && !/^[\w-]+\.test\.ts$/.test(file)) {
      throw new Error(
        "--file requires an end-to-end test filename, such as network.test.ts",
      );
    }
    if (timeout !== undefined && !/^[1-9]\d*$/.test(timeout)) {
      throw new Error("--timeout requires a positive integer in milliseconds");
    }
    process.exitCode = await runE2e({
      repoRoot,
      suite: extended ? "extended" : "core",
      runtime,
      file,
      testNamePattern: values["test-name-pattern"],
      timeout,
    });
  }
}
