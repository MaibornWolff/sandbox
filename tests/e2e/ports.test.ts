import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

let projectDir: string;
let sb: SandboxInstance;
let hostPort: number;
let serverSession: ReturnType<SandboxInstance["run"]> | undefined;
let serverResult: Awaited<ReturnType<SandboxInstance["run"]>> | undefined;

async function reserveHostPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate a host port for the E2E test");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

beforeAll(async () => {
  projectDir = await createTempProject("ports");
  hostPort = await reserveHostPort();
  await writeProjectFile(
    projectDir,
    ".sandbox/config.toml",
    `ports = ["127.0.0.1:${hostPort}:8080"]\n`,
  );
  await writeProjectFile(
    projectDir,
    "published.txt",
    "published-through-docker",
  );
  sb = createSandbox({ cwd: projectDir, timeoutSeconds: 60 });
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
  await serverSession;
});

describe("published ports", () => {
  test("serves a container endpoint through the configured host port", async () => {
    serverSession = sb.run(
      "python3",
      "-m",
      "http.server",
      "8080",
      "--bind",
      "0.0.0.0",
    );
    void serverSession.then((result) => {
      serverResult = result;
    });

    const deadline = Date.now() + 30_000;
    let lastRequestError = "No HTTP response received";
    while (Date.now() < deadline) {
      if (serverResult) {
        throw new Error(
          `Container HTTP server exited before the port became reachable ` +
            `(exit ${serverResult.exitCode}).\n` +
            `stdout:\n${serverResult.stdout}\n` +
            `stderr:\n${serverResult.stderr}`,
        );
      }
      try {
        const response = await fetch(
          `http://127.0.0.1:${hostPort}/published.txt`,
          { signal: AbortSignal.timeout(1_000) },
        );
        if (response.ok) {
          expect(await response.text()).toBe("published-through-docker");
          return;
        }
        lastRequestError = `HTTP ${response.status} ${response.statusText}`;
      } catch (error) {
        lastRequestError =
          error instanceof Error ? error.message : String(error);
      }
      await Bun.sleep(250);
    }

    throw new Error(
      `Container port was not reachable on 127.0.0.1:${hostPort}. ` +
        `Last request error: ${lastRequestError}`,
    );
  }, 120_000);
});
