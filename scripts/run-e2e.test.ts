import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createE2eRuntimeSnapshot,
  type E2eCommand,
  type E2eRuntimeSnapshot,
  runE2e,
} from "./run-e2e.js";

const testTempRoot = fileURLToPath(new URL("../test-tmp/", import.meta.url));

function createTestDirectory(prefix: string): string {
  mkdirSync(testTempRoot, { recursive: true });
  return mkdtempSync(path.join(testTempRoot, `${prefix}-`));
}

function removeTestDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

describe("E2E runner", () => {
  test("copies immutable runtime assets before running tests", async () => {
    using cleanup = new DisposableStack();
    const repoRoot = createTestDirectory("e2e-runner-source");
    cleanup.defer(() => removeTestDirectory(repoRoot));
    const tempRoot = createTestDirectory("e2e-runner-snapshots");
    cleanup.defer(() => removeTestDirectory(tempRoot));

    for (const directory of ["docker", "templates"]) {
      mkdirSync(path.join(repoRoot, directory), { recursive: true });
    }
    writeFileSync(
      path.join(repoRoot, "package.json"),
      '{"name":"@maibornwolff/sandbox"}',
    );
    writeFileSync(path.join(repoRoot, "docker/Dockerfile"), "FROM scratch");
    writeFileSync(
      path.join(repoRoot, "templates/config.toml"),
      "runtime='docker'",
    );

    await using snapshot = await createE2eRuntimeSnapshot({
      repoRoot,
      tempRoot,
    });
    writeFileSync(path.join(repoRoot, "docker/Dockerfile"), "changed");

    expect(
      await Bun.file(path.join(snapshot.root, "docker/Dockerfile")).text(),
    ).toBe("FROM scratch");
    expect(snapshot.binaryPath).toBe(
      path.join(snapshot.root, "dist/apps/sandbox/main.js"),
    );
    expect(existsSync(path.join(snapshot.root, "docker/Dockerfile"))).toBe(
      true,
    );
    expect(existsSync(path.join(snapshot.root, "templates/config.toml"))).toBe(
      true,
    );
    expect(existsSync(path.join(snapshot.root, "package.json"))).toBe(true);
  });

  test("makes the runtime snapshot traversable by the container user", async () => {
    using cleanup = new DisposableStack();
    const repoRoot = createTestDirectory("e2e-runner-readable-source");
    cleanup.defer(() => removeTestDirectory(repoRoot));
    const tempRoot = createTestDirectory("e2e-runner-readable-snapshots");
    cleanup.defer(() => removeTestDirectory(tempRoot));

    for (const directory of ["docker", "templates"]) {
      mkdirSync(path.join(repoRoot, directory), { recursive: true });
    }
    writeFileSync(
      path.join(repoRoot, "package.json"),
      '{"name":"@maibornwolff/sandbox"}',
    );

    await using snapshot = await createE2eRuntimeSnapshot({
      repoRoot,
      tempRoot,
    });

    expect(statSync(snapshot.root).mode & 0o005).toBe(0o005);
  });

  test("keeps the snapshot until the test process exits", async () => {
    const commands: E2eCommand[] = [];
    const testProcess = Promise.withResolvers<number>();
    let disposed = false;
    const snapshot: E2eRuntimeSnapshot = {
      root: "/snapshot",
      binaryPath: "/snapshot/dist/apps/sandbox/main.js",
      async [Symbol.asyncDispose]() {
        disposed = true;
      },
    };

    const execution = runE2e({
      repoRoot: "/repo",
      runCommand: async (command) => {
        commands.push(command);
        return commands.length === 1 ? 0 : testProcess.promise;
      },
      createSnapshot: async () => snapshot,
    });
    while (commands.length < 2) await Promise.resolve();

    expect(disposed).toBe(false);
    testProcess.resolve(0);
    expect(await execution).toBe(0);
    expect(commands).toEqual([
      {
        args: ["run", "build"],
        cwd: "/repo",
        env: { SANDBOX_BUILD_DIR: "/snapshot/dist" },
      },
      {
        args: ["test", "--timeout", "30000", "tests/e2e/"],
        cwd: "/repo",
        env: {
          SANDBOX_BIN: "/snapshot/dist/apps/sandbox/main.js",
          SANDBOX_RUNTIME_ROOT: "/snapshot",
        },
      },
    ]);
    expect(disposed).toBe(true);
  });

  test("removes the snapshot when the isolated build fails", async () => {
    let disposed = false;
    const exitCode = await runE2e({
      repoRoot: "/repo",
      runCommand: async () => 9,
      createSnapshot: async () => ({
        root: "/snapshot",
        binaryPath: "/snapshot/dist/apps/sandbox/main.js",
        async [Symbol.asyncDispose]() {
          disposed = true;
        },
      }),
    });

    expect(exitCode).toBe(9);
    expect(disposed).toBe(true);
  });
});
