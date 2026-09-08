import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface E2eCommand {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface E2eRuntimeSnapshot extends AsyncDisposable {
  readonly root: string;
  readonly binaryPath: string;
}

interface CreateE2eRuntimeSnapshotOptions {
  readonly repoRoot: string;
  readonly tempRoot?: string;
}

interface RunE2eOptions {
  readonly repoRoot: string;
  readonly runCommand?: (command: E2eCommand) => Promise<number>;
  readonly createSnapshot?: (
    options: CreateE2eRuntimeSnapshotOptions,
  ) => Promise<E2eRuntimeSnapshot>;
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

export async function createE2eRuntimeSnapshot(
  options: CreateE2eRuntimeSnapshotOptions,
): Promise<E2eRuntimeSnapshot> {
  const tempRoot = options.tempRoot ?? path.join(options.repoRoot, "test-tmp");
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(path.join(tempRoot, "e2e-runtime-"));
  await Promise.all([
    chmod(root, 0o755),
    ...["docker", "templates"].map((entry) =>
      cp(path.join(options.repoRoot, entry), path.join(root, entry), {
        recursive: true,
      }),
    ),
    cp(
      path.join(options.repoRoot, "package.json"),
      path.join(root, "package.json"),
    ),
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

export async function runE2e(options: RunE2eOptions): Promise<number> {
  const execute = options.runCommand ?? runCommand;
  const createSnapshot = options.createSnapshot ?? createE2eRuntimeSnapshot;
  await using snapshot = await createSnapshot({ repoRoot: options.repoRoot });
  const buildExitCode = await execute({
    args: ["run", "build"],
    cwd: options.repoRoot,
    env: { SANDBOX_BUILD_DIR: path.join(snapshot.root, "dist") },
  });
  if (buildExitCode !== 0) return buildExitCode;

  return await execute({
    args: ["test", "--timeout", "30000", "tests/e2e/"],
    cwd: options.repoRoot,
    env: {
      SANDBOX_BIN: snapshot.binaryPath,
      SANDBOX_RUNTIME_ROOT: snapshot.root,
    },
  });
}

if (import.meta.main) {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  process.exitCode = await runE2e({ repoRoot });
}
