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
    url: `wss://${server.endpoint.host}:${server.endpoint.port}/session`,
    protocol: options.protocol ?? protocol,
    maxMessageBytes: options.maxBytes ?? maxMessageBytes,
    pinnedCertificate: server.certificate,
  });
}

async function runNodeProtocolFixture(entrypoint: URL): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
}> {
  using cleanup = new DisposableStack();
  const outputDirectory = createTestDir("node-websocket-service");
  cleanup.defer(() => cleanupTestDir(outputDirectory));
  const fixtureEntryPoint = fileURLToPath(entrypoint);
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
    `${path.basename(fixtureEntryPoint, ".ts")}.js`,
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
        url: `wss://${server.endpoint.host}:${server.endpoint.port}/private`,
        protocol,
        maxMessageBytes,
        pinnedCertificate: server.certificate,
        headers: { authorization: "Bearer wrong" },
      }),
    ).rejects.toThrow("401");
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
    ).rejects.toThrow("426");
    expect(authorizationCalled).toBe(false);
  });

  test("preserves Node WebSocket protocol details", async () => {
    expect(
      await runNodeProtocolFixture(
        new URL(
          "../../../scripts/fixtures/node-websocket-service-node-fixture.ts",
          import.meta.url,
        ),
      ),
    ).toEqual({
      exitCode: 0,
      stderr: "",
    });
  });

  test("pins private TLS certificates under Node without changing system trust", async () => {
    expect(
      await runNodeProtocolFixture(
        new URL("./__test__/tls-fixture.ts", import.meta.url),
      ),
    ).toEqual({ exitCode: 0, stderr: "" });
  });

  test("honors an aborted connection signal", async () => {
    const service = createNodeWebSocketService();
    const connectionAbort = new AbortController();
    connectionAbort.abort();
    await expect(
      service.connect({
        url: "wss://127.0.0.1:1",
        protocol,
        maxMessageBytes,
        pinnedCertificate: "unused",
        signal: connectionAbort.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("disposes sockets while upgrade authorization is still pending", async () => {
    const authorized = Promise.withResolvers<{ accepted: true }>();
    const entered = Promise.withResolvers<void>();
    const service = createNodeWebSocketService();
    await using server = await service.startServer({
      host: "127.0.0.1",
      port: 0,
      protocol,
      maxMessageBytes,
      authorizeUpgrade: () => {
        entered.resolve();
        return authorized.promise;
      },
    });
    const connecting = connectTo(server);
    void connecting.catch(() => undefined);
    await entered.promise;
    await server[Symbol.asyncDispose]();
    authorized.resolve({ accepted: true });
    await expect(connecting).rejects.toThrow();
    expect((await server.connections[Symbol.asyncIterator]().next()).done).toBe(
      true,
    );
  });

  test("bounds concurrent sends before they can fill the socket buffer", async () => {
    const service = createNodeWebSocketService();
    await using server = await service.startServer({
      host: "127.0.0.1",
      port: 0,
      protocol,
      maxMessageBytes: 1024,
      authorizeUpgrade: () => ({ accepted: true }),
    });
    await using connection = await connectTo(server, { maxBytes: 1024 });
    const sends = Array.from({ length: 5 }, () =>
      connection.sendBinary(new Uint8Array(1024)),
    );
    const outcomes = await Promise.allSettled(sends);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    await expect(connection.sendBinary(new Uint8Array(1025))).rejects.toThrow(
      "maximum size",
    );
  });

  test("provides the service through the dependency scope", () => {
    const service = createNodeWebSocketService();
    runWithDependencies([provideWebSocketService(service)], () => {
      expect(getWebSocketService()).toBe(service);
    });
  });
});
