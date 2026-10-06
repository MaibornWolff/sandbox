import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  cleanupTestDir,
  createTestDir,
  getTestRepoRootPath,
} from "#test/utils.js";

export async function createUpdateWorkerFixture(status = 200) {
  await using resources = new AsyncDisposableStack();
  let safeToRemove = true;
  const root = createTestDir("production-update-worker");
  resources.defer(() => {
    if (safeToRemove) cleanupTestDir(root);
  });
  const config = path.join(root, "config");
  const data = path.join(root, "data");
  const entry = path.join(root, "dist", "apps", "sandbox", "main.js");
  const cachePath = path.join(data, "sandbox", "update-check", "cache.json");
  const statePath = path.join(data, "sandbox", "state.json");
  const workerStartPath = path.join(root, "worker-starts");
  const workerExitPath = path.join(root, "worker-exits");
  const preloadPath = path.join(root, "worker preload.cjs");
  fs.writeFileSync(
    preloadPath,
    `const fs = require("node:fs");
if (process.argv.includes("--internal-update-check")) {
  fs.appendFileSync(${JSON.stringify(workerStartPath)}, process.pid + "\\n");
  process.once("exit", () => {
    fs.appendFileSync(${JSON.stringify(workerExitPath)}, process.pid + "\\n");
  });
  setTimeout(() => {}, 1200);
}
`,
  );
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(path.join(config, "config.toml"), "invalid = [");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@maibornwolff/sandbox",
      version: "1.0.0",
      type: "module",
    }),
  );
  const repository = await getTestRepoRootPath();
  fs.cpSync(path.join(repository, "templates"), path.join(root, "templates"), {
    recursive: true,
  });
  const built = await Bun.build({
    entrypoints: [path.join(repository, "src", "apps", "sandbox", "main.ts")],
    outdir: path.dirname(entry),
    target: "node",
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  const gate = Promise.withResolvers<void>();
  const request = Promise.withResolvers<void>();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      requests++;
      request.resolve();
      await gate.promise;
      return Response.json(
        {
          name: "@maibornwolff/sandbox",
          "dist-tags": { latest: "2.0.0" },
          versions: {
            "2.0.0": { name: "@maibornwolff/sandbox", version: "2.0.0" },
          },
        },
        { status },
      );
    },
  });
  resources.defer(() => server.stop(true));
  let launched = false;
  let recordedStarts: string[] = [];
  let recordedExits: string[] = [];
  const readPids = (file: string): string[] =>
    fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];
  const workerStarts = () =>
    fs.existsSync(root) ? readPids(workerStartPath) : recordedStarts;
  const workerExits = () =>
    fs.existsSync(root) ? readPids(workerExitPath) : recordedExits;
  const parents: Promise<{ exitCode: number | null; stderr: string }>[] = [];
  const env = {
    ...process.env,
    SANDBOX: "0",
    SANDBOX_CONFIG_DIR: config,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    npm_config_registry: server.url.href,
    npm_config_cache: path.join(root, "npm-cache"),
    npm_config_userconfig: path.join(root, "npmrc"),
    npm_config_fetch_retries: "0",
    npm_config_update_notifier: "false",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preloadPath)}`,
  };
  fs.writeFileSync(env.npm_config_userconfig, "");
  function cache(): { latestVersion?: string; error?: string } {
    return fs.existsSync(cachePath)
      ? JSON.parse(fs.readFileSync(cachePath, "utf8"))
      : {};
  }
  async function waitForWorkerExit(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const starts = workerStarts();
      const exits = workerExits();
      if (starts.length > 0 && starts.every((pid) => exits.includes(pid))) {
        recordedStarts = starts;
        recordedExits = exits;
        safeToRemove = true;
        return;
      }
      await delay(50);
    }
    const active = workerStarts().filter((pid) => !workerExits().includes(pid));
    throw new Error(
      `Update worker did not exit within 10 seconds. Files retained because process exit is unconfirmed (pids: ${active.join(", ") || "none"}, files: ${root}).`,
    );
  }
  async function waitForCache(): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (cache().latestVersion || cache().error) return;
      await delay(50);
    }
    throw new Error("Update worker did not write its result");
  }
  resources.defer(async () => {
    const results = await Promise.allSettled(parents);
    if (launched) {
      await waitForWorkerExit();
      await waitForCache();
    }
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Update worker fixture parent invocation failed",
      );
  });
  const cleanup = resources.move();
  return {
    run(args: readonly string[] = ["run", "ls"]) {
      launched = true;
      safeToRemove = false;
      const execution = new Promise<{
        exitCode: number | null;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn("node", [entry, ...args], {
          cwd: root,
          env,
          stdio: ["ignore", "ignore", "pipe"],
          timeout: 10_000,
        });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.once("error", reject);
        child.once("close", (exitCode) => resolve({ exitCode, stderr }));
      });
      parents.push(execution);
      return execution;
    },
    waitForRequest: () => request.promise,
    release: () => gate.resolve(),
    waitForCache,
    cache,
    workerStarts,
    workerExits,
    requests: () => requests,
    writeState: (value: unknown) =>
      fs.writeFileSync(statePath, JSON.stringify(value)),
    readState: (): unknown => JSON.parse(fs.readFileSync(statePath, "utf8")),
    async [Symbol.asyncDispose]() {
      gate.resolve();
      await cleanup.disposeAsync();
    },
  };
}
