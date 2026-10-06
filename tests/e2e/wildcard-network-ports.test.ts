import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { createSandbox, type SandboxInstance } from "./utils/sandbox.js";

let projectDir: string;
let sb: SandboxInstance;
let hostServer: Server;
let hostPort: number;

beforeAll(async () => {
  hostServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("wildcard-port-service\n");
  });
  await new Promise<void>((resolve, reject) => {
    hostServer.once("error", reject);
    hostServer.listen(0, "0.0.0.0", resolve);
  });
  const address = hostServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate a host service port");
  }
  hostPort = address.port;

  projectDir = await createTempProject("wildcard-network-ports");
  await writeProjectFile(
    projectDir,
    ".sandbox/config.toml",
    `allow_network = [
  "host.docker.internal:*",
  "registry.npmjs.org:443",
]
`,
  );
  await writeProjectFile(
    projectDir,
    ".sandbox/docker/Dockerfile",
    "FROM sandbox-base:latest\nENV SANDBOX_IDLE_TIMEOUT_SECONDS=30\n",
  );
  sb = createSandbox({ cwd: projectDir, timeoutSeconds: 60 });
});

afterAll(async () => {
  await cleanupProject(projectDir, sb);
  await new Promise<void>((resolve, reject) => {
    hostServer.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("wildcard network port enforcement", () => {
  test("allows all ports only for the configured host", async () => {
    const allowed = await sb.run(
      "curl",
      "-sS",
      "--noproxy",
      "",
      "--proxy",
      "http://127.0.0.1:8888",
      `http://host.docker.internal:${hostPort}/`,
    );
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout).toContain("wildcard-port-service");

    const blocked = await sb.run(
      "curl",
      "-sS",
      "--noproxy",
      "",
      "--proxy",
      "http://127.0.0.1:8888",
      "--write-out",
      "\n%{http_code}\n",
      `http://registry.npmjs.org:${hostPort}/`,
    );
    expect(blocked.exitCode).toBe(0);
    expect(blocked.stdout).toContain("HTTP 403 Blocked");
    expect(blocked.stdout).toEndWith("\n403\n");
  }, 120_000);
});
