import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { createNodeWebSocketService } from "./node-websocket-service.js";
import {
  getWebSocketService,
  provideWebSocketService,
  type WebSocketConnection,
  type WebSocketServer,
} from "./websocket-service.js";

const protocol = "sandbox-test.v1";
const maxMessageBytes = 32 * 1024 * 1024;

async function connectTo(
  server: WebSocketServer,
  options: { readonly protocol?: string; readonly maxBytes?: number } = {},
): Promise<WebSocketConnection> {
  return createNodeWebSocketService().connect({
    url: `ws://${server.endpoint.host}:${server.endpoint.port}/session`,
    protocol: options.protocol ?? protocol,
    maxMessageBytes: options.maxBytes ?? maxMessageBytes,
  });
}

async function runNodeProtocolFixture(): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
}> {
  using cleanup = new DisposableStack();
  const outputDirectory = createTestDir("node-websocket-service");
  cleanup.defer(() => cleanupTestDir(outputDirectory));
  const fixtureEntryPoint = fileURLToPath(
    new URL(
      "../../../scripts/fixtures/node-websocket-service-node-fixture.ts",
      import.meta.url,
    ),
  );
  const build = await Bun.build({
    entrypoints: [fixtureEntryPoint],
    outdir: outputDirectory,
    target: "node",
    format: "esm",
    packages: "bundle",
  });
  if (!build.success) {
    throw new Error(
      `Node WebSocket fixture build failed: ${build.logs.map((log) => log.message).join("\n")}`,
    );
  }
  const fixturePath = path.join(
    outputDirectory,
    "node-websocket-service-node-fixture.js",
  );
  const fixture = Bun.spawn(["node", fixturePath], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    fixture.exited,
    new Response(fixture.stderr).text(),
  ]);
  return { exitCode, stderr };
}

describe("node WebSocket service", () => {
  test("rejects an unauthorized upgrade before exposing a connection", async () => {
    let upgradeCount = 0;
    const service = createNodeWebSocketService();
    await using server = await service.startServer({
      host: "127.0.0.1",
      port: 0,
      protocol,
      maxMessageBytes,
      authorizeUpgrade: (metadata) => {
        upgradeCount += 1;
        expect(metadata.path).toBe("/private");
        expect(metadata.headers.authorization).toBe("Bearer wrong");
        return { accepted: false, statusCode: 401, reason: "Unauthorized" };
      },
    });

    await expect(
      service.connect({
        url: `ws://${server.endpoint.host}:${server.endpoint.port}/private`,
        protocol,
        maxMessageBytes,
        headers: { authorization: "Bearer wrong" },
      }),
    ).rejects.toThrow(
      "WebSocket connection failed during the opening handshake.",
    );
    expect(upgradeCount).toBe(1);
  });

  test("rejects a client without the required subprotocol", async () => {
    let authorizationCalled = false;
    const service = createNodeWebSocketService();
    await using server = await service.startServer({
      host: "127.0.0.1",
      port: 0,
      protocol,
      maxMessageBytes,
      authorizeUpgrade: () => {
        authorizationCalled = true;
        return { accepted: true };
      },
    });

    await expect(
      connectTo(server, { protocol: "unsupported.v1" }),
    ).rejects.toThrow(
      "WebSocket connection failed during the opening handshake.",
    );
    expect(authorizationCalled).toBe(false);
  });

  test("preserves Node WebSocket protocol details", async () => {
    expect(await runNodeProtocolFixture()).toEqual({
      exitCode: 0,
      stderr: "",
    });
  });

  test("honors an aborted connection signal", async () => {
    const service = createNodeWebSocketService();
    const connectionAbort = new AbortController();
    connectionAbort.abort();
    await expect(
      service.connect({
        url: "ws://127.0.0.1:1",
        protocol,
        maxMessageBytes,
        signal: connectionAbort.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("rejects an abort that occurs while the server starts listening", async () => {
    const controller = new AbortController();
    const service = createNodeWebSocketService();
    const starting = service.startServer({
      host: "127.0.0.1",
      port: 0,
      protocol,
      maxMessageBytes,
      signal: controller.signal,
      authorizeUpgrade: () => ({ accepted: true }),
    });

    controller.abort();

    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
  });

  test("provides the service through the dependency scope", () => {
    const service = createNodeWebSocketService();
    runWithDependencies([provideWebSocketService(service)], () => {
      expect(getWebSocketService()).toBe(service);
    });
  });
});
