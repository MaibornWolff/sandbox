import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashDirectoryContents } from "#platform/filesystem/index.js";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { prepareSandboxRuntimeFromPackage } from "./runtime-cache.js";
import type { RuntimePackage } from "./runtime-package.js";

function createRuntimePackage(root: string, version: string): RuntimePackage {
  const directory = path.join(root, "package");
  for (const app of ["sandbox", "sandbox-container-tools"]) {
    const appDirectory = path.join(directory, "dist", "apps", app);
    mkdirSync(appDirectory, { recursive: true });
    writeFileSync(path.join(appDirectory, "main.js"), `console.log('${app}')`);
  }
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ version }),
  );
  return { directory, version };
}

function startPublisher(options: {
  readonly root: string;
  readonly runtimePackage: RuntimePackage;
  readonly cleanup: DisposableStack;
}) {
  const { root, runtimePackage, cleanup } = options;
  const outputDirectory = path.join(root, "publisher");
  const child = spawn(
    "node",
    [
      path.join(outputDirectory, "runtime-cache-publisher.js"),
      runtimePackage.directory,
      runtimePackage.version,
    ],
    {
      env: { ...process.env, XDG_DATA_HOME: path.join(root, "data") },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      signal: AbortSignal.timeout(15_000),
    },
  );
  cleanup.defer(() => child.kill());
  if (!child.stdout || !child.stderr) {
    throw new Error("Runtime publisher requires piped stdout and stderr");
  }
  const ready = new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve());
    child.once("error", reject);
    child.once("exit", () =>
      reject(new Error("Publisher exited before readiness")),
    );
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const completed = new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0)
        reject(new Error(`Publisher exited with ${code}: ${stderr}`));
      else resolve(stdout);
    });
  });
  return { child, ready, completed };
}

test("independent processes publish complete contents into the same cache", async () => {
  const root = createTestDir("runtime-cache-concurrent");
  using cleanup = new DisposableStack();
  cleanup.defer(() => cleanupTestDir(root));
  const runtimePackage = createRuntimePackage(root, "1.70.0");
  for (let index = 0; index < 32; index += 1) {
    writeFileSync(
      path.join(runtimePackage.directory, `payload-${index}`),
      Buffer.alloc(128 * 1024, index),
    );
  }
  const outputDirectory = path.join(root, "publisher");
  const build = await Bun.build({
    entrypoints: [
      fileURLToPath(
        new URL(
          "../../../scripts/fixtures/runtime-cache-publisher.ts",
          import.meta.url,
        ),
      ),
    ],
    outdir: outputDirectory,
    target: "node",
    format: "esm",
    packages: "bundle",
  });
  expect(build.success, build.logs.map((log) => log.message).join("\n")).toBe(
    true,
  );
  const publishers = [0, 1].map(() =>
    startPublisher({ root, runtimePackage, cleanup }),
  );
  await Promise.all(publishers.map((publisher) => publisher.ready));
  for (const publisher of publishers) publisher.child.send("publish");
  const outputs = await Promise.all(
    publishers.map((publisher) => publisher.completed),
  );
  expect(outputs[0]).toBe(outputs[1]);
  const published: { id: string; mount: { hostPath: string; mode: string } } =
    JSON.parse(outputs[0] ?? "");
  expect(published.mount.mode).toBe("ro");
  expect(hashDirectoryContents(published.mount.hostPath)).toBe(
    hashDirectoryContents(runtimePackage.directory),
  );
  expect(readdirSync(path.dirname(published.mount.hostPath)).sort()).toEqual([
    ".leases",
    published.id,
  ]);
}, 30_000);

test("materializes a versioned runtime cache and reuses immutable contents", async () => {
  const root = createTestDir("runtime-cache");
  using cleanup = new DisposableStack();
  cleanup.defer(() => cleanupTestDir(root));
  const runtimePackage = createRuntimePackage(root, "1.70.0-beta.1");

  await runInHostTestScope({ root }, async () => {
    await using first = await prepareSandboxRuntimeFromPackage(runtimePackage);
    expect(first.id).toMatch(/^1\.70\.0-beta\.1-[a-f0-9]{64}$/);
    expect(first.mount).toEqual({
      hostPath: path.join(root, "data", "sandbox", "runtime", first.id),
      containerPath: "/opt/sandbox-cli",
      mode: "ro",
    });
    expect(statSync(first.mount.hostPath).mode & 0o777).toBe(0o755);
    expect(
      readFileSync(
        path.join(first.mount.hostPath, "dist/apps/sandbox/main.js"),
        "utf8",
      ),
    ).toContain("sandbox");

    writeFileSync(
      path.join(first.mount.hostPath, "cache-sentinel"),
      "preserved",
    );
    await using reused = await prepareSandboxRuntimeFromPackage(runtimePackage);
    expect(reused.id).toBe(first.id);
    expect(reused.mount).toEqual(first.mount);
    expect(
      readFileSync(path.join(first.mount.hostPath, "cache-sentinel"), "utf8"),
    ).toBe("preserved");
  });
});

test("does not require explicit resource management globals", async () => {
  const root = createTestDir("runtime-cache-node-22");
  using cleanup = new DisposableStack();
  cleanup.defer(() => cleanupTestDir(root));
  const runtimePackage = createRuntimePackage(root, "1.70.0");
  const asyncDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "AsyncDisposableStack",
  );
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "DisposableStack",
  );
  using _restore = {
    [Symbol.dispose]() {
      if (asyncDescriptor) {
        Object.defineProperty(
          globalThis,
          "AsyncDisposableStack",
          asyncDescriptor,
        );
      } else {
        Reflect.deleteProperty(globalThis, "AsyncDisposableStack");
      }
      if (descriptor) {
        Object.defineProperty(globalThis, "DisposableStack", descriptor);
      } else {
        Reflect.deleteProperty(globalThis, "DisposableStack");
      }
    },
  };
  Object.defineProperty(globalThis, "AsyncDisposableStack", {
    configurable: true,
    value: undefined,
  });
  Object.defineProperty(globalThis, "DisposableStack", {
    configurable: true,
    value: undefined,
  });

  await runInHostTestScope({ root }, async () => {
    await using runtime =
      await prepareSandboxRuntimeFromPackage(runtimePackage);
    expect(runtime.mount.hostPath).toContain(runtime.id);
  });
});

test("uses a new cache directory when contents change without a version change", async () => {
  const root = createTestDir("runtime-cache-change");
  using cleanup = new DisposableStack();
  cleanup.defer(() => cleanupTestDir(root));
  const runtimePackage = createRuntimePackage(root, "1.70.0");

  await runInHostTestScope({ root }, async () => {
    await using first = await prepareSandboxRuntimeFromPackage(runtimePackage);
    writeFileSync(
      path.join(runtimePackage.directory, "dist/apps/sandbox/main.js"),
      "console.log('changed')",
    );
    await using second = await prepareSandboxRuntimeFromPackage(runtimePackage);

    expect(second.id).not.toBe(first.id);
    expect(second.mount.hostPath).not.toBe(first.mount.hostPath);
    expect(
      readFileSync(
        path.join(second.mount.hostPath, "dist/apps/sandbox/main.js"),
        "utf8",
      ),
    ).toContain("changed");
  });
});
