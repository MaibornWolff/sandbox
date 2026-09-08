import { describe, expect, test } from "bun:test";
import { getEventListeners, once } from "node:events";
import * as net from "node:net";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createNodeTcpService,
  getTcpService,
  provideTcpService,
} from "./tcp-service.js";

interface LoopbackServer {
  readonly server: net.Server;
  readonly endpoint: { readonly host: string; readonly port: number };
}

async function listenOnLoopback(): Promise<LoopbackServer> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Loopback server did not publish a TCP address.");
  }
  return {
    server,
    endpoint: { host: "127.0.0.1", port: address.port },
  };
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("Node TCP service", () => {
  test("provides one TCP adapter to the current application scope", () => {
    const service = createNodeTcpService();

    expect(
      runWithDependencies([provideTcpService(service)], () => getTcpService()),
    ).toBe(service);
  });

  test("rejects an already-aborted request without opening a connection", async () => {
    const loopback = await listenOnLoopback();
    const controller = new AbortController();
    controller.abort();
    try {
      expect(
        await createNodeTcpService().canConnect(loopback.endpoint, {
          timeoutMilliseconds: 1_000,
          signal: controller.signal,
        }),
      ).toBe(false);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      await closeServer(loopback.server);
    }
  });

  test("connects to loopback and closes the client socket after settling", async () => {
    const loopback = await listenOnLoopback();
    const controller = new AbortController();
    const accepted = once(loopback.server, "connection");
    try {
      const result = createNodeTcpService().canConnect(loopback.endpoint, {
        timeoutMilliseconds: 1_000,
        signal: controller.signal,
      });
      const [socket] = (await accepted) as [net.Socket];
      expect(await result).toBe(true);
      if (!socket.destroyed) await once(socket, "close");
      expect(socket.destroyed).toBe(true);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      controller.abort();
      expect(await result).toBe(true);
    } finally {
      await closeServer(loopback.server);
    }
  });

  test("returns false when loopback refuses the connection", async () => {
    const loopback = await listenOnLoopback();
    const endpoint = loopback.endpoint;
    await closeServer(loopback.server);

    expect(
      await createNodeTcpService().canConnect(endpoint, {
        timeoutMilliseconds: 1_000,
      }),
    ).toBe(false);
  });

  test("enforces a zero-millisecond connection deadline", async () => {
    const loopback = await listenOnLoopback();
    try {
      expect(
        await createNodeTcpService().canConnect(loopback.endpoint, {
          timeoutMilliseconds: 0,
        }),
      ).toBe(false);
    } finally {
      await closeServer(loopback.server);
    }
  });

  test("aborts after socket creation and removes the abort listener", async () => {
    const loopback = await listenOnLoopback();
    const controller = new AbortController();
    try {
      const result = createNodeTcpService().canConnect(loopback.endpoint, {
        timeoutMilliseconds: 1_000,
        signal: controller.signal,
      });
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      controller.abort();
      expect(await result).toBe(false);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      await closeServer(loopback.server);
    } finally {
      await closeServer(loopback.server);
    }
  });
});
