import { describe, expect, test } from "bun:test";
import {
  createNodeWebSocketService,
  type WebSocketConnection,
  type WebSocketMessage,
  type WebSocketServer,
} from "#platform/websocket/index.js";
import { setupSandboxAppTest } from "./__test__/sandbox-app-test.js";

const PROTOCOL = "sandbox-host-command-escape.v1";
const TOKEN = "test-session-token";

async function nextValue<T>(values: AsyncIterable<T>): Promise<T> {
  const result = await values[Symbol.asyncIterator]().next();
  if (result.done) throw new Error("Expected an asynchronous value.");
  return result.value;
}

async function createBroker(): Promise<{
  readonly server: WebSocketServer;
  readonly variables: Readonly<Record<string, string>>;
}> {
  const server = await createNodeWebSocketService().startServer({
    host: "127.0.0.1",
    port: 0,
    protocol: PROTOCOL,
    maxMessageBytes: 1024 * 1024,
    authorizeUpgrade: ({ headers }) => ({
      accepted: headers.authorization === `Bearer ${TOKEN}`,
    }),
  });
  return {
    server,
    variables: {
      SANDBOX: "1",
      SANDBOX_HOST_COMMAND_ESCAPE_ENDPOINT: `ws://127.0.0.1:${server.endpoint.port}/session`,
      SANDBOX_HOST_COMMAND_ESCAPE_PROTOCOL: PROTOCOL,
      SANDBOX_HOST_COMMAND_ESCAPE_TOKEN: TOKEN,
    },
  };
}

async function readControl(connection: WebSocketConnection): Promise<unknown> {
  const message: WebSocketMessage = await nextValue(connection.messages);
  if (message.type !== "text") throw new Error("Expected a control message.");
  return JSON.parse(message.data) as unknown;
}

describe("sandbox escape", () => {
  test("lists effective patterns without a heading", async () => {
    await using broker = await createBroker().then(({ server, variables }) => ({
      server,
      variables,
      async [Symbol.asyncDispose]() {
        await server[Symbol.asyncDispose]();
      },
    }));
    await using app = await setupSandboxAppTest({
      variables: broker.variables,
    });
    const connectionPromise = nextValue(broker.server.connections);
    const execution = app.cli.run("escape", "--list");
    await using connection = await connectionPromise;
    expect(await readControl(connection)).toEqual({ type: "list" });
    await connection.sendText(
      JSON.stringify({
        type: "allowed-commands",
        patterns: [
          '["open",{"repeat":{"regex":".+"},"min":1,"max":10}]',
          '["bun","run","test:e2e"]',
        ],
      }),
    );
    await connection.close(1000, "complete");

    const result = await execution;
    expect(result).toEqual({
      exitCode: 0,
      stdout:
        '["open",{"repeat":{"regex":".+"},"min":1,"max":10}]\n["bun","run","test:e2e"]\n',
      stderr: "",
    });
  });

  test("prints no output for an empty effective policy", async () => {
    await using broker = await createBroker().then(({ server, variables }) => ({
      server,
      variables,
      async [Symbol.asyncDispose]() {
        await server[Symbol.asyncDispose]();
      },
    }));
    await using app = await setupSandboxAppTest({
      variables: broker.variables,
    });
    const connectionPromise = nextValue(broker.server.connections);
    const execution = app.cli.run("escape", "--list");
    await using connection = await connectionPromise;
    expect(await readControl(connection)).toEqual({ type: "list" });
    await connection.sendText(
      JSON.stringify({ type: "allowed-commands", patterns: [] }),
    );
    await connection.close(1000, "complete");

    expect(await execution).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("preserves each argument after the separator and returns the child exit code", async () => {
    await using broker = await createBroker().then(({ server, variables }) => ({
      server,
      variables,
      async [Symbol.asyncDispose]() {
        await server[Symbol.asyncDispose]();
      },
    }));
    await using app = await setupSandboxAppTest({
      variables: broker.variables,
    });
    const connectionPromise = nextValue(broker.server.connections);
    const execution = app.cli.run(
      "escape",
      "--",
      "tool",
      "--flag",
      "two words",
      "NAME=value",
    );
    await using connection = await connectionPromise;
    expect(await readControl(connection)).toEqual({
      type: "execute",
      argv: ["tool", "--flag", "two words", "NAME=value"],
      cwd: app.project.root,
    });
    await connection.sendText(JSON.stringify({ type: "ready" }));
    await connection.sendText(JSON.stringify({ type: "exit", exitCode: 23 }));
    await connection.close(1000, "complete");

    const result = await execution;
    expect(result.exitCode).toBe(23);
    expect(result.stderr).toBe("");
  });

  test("rejects missing commands, invalid list combinations, and host use", async () => {
    await using app = await setupSandboxAppTest();

    const missing = await app.cli.run("escape");
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("missing host command after '--'");

    const combined = await app.cli.run("escape", "--list", "tool");
    expect(combined.exitCode).toBe(1);
    expect(combined.stderr).toContain(
      "--list cannot be combined with a command",
    );

    const host = await app.cli.run("escape", "--", "tool");
    expect(host.exitCode).toBe(1);
    expect(host.stderr).toBe(
      "sandbox escape: no active host command escape broker\n",
    );

    await using containerWithoutSession = await setupSandboxAppTest({
      variables: { SANDBOX: "1" },
    });
    const container = await containerWithoutSession.cli.run(
      "escape",
      "--",
      "tool",
    );
    expect(container.exitCode).toBe(1);
    expect(container.stderr).toBe(
      "sandbox escape: no active host command escape broker\n",
    );
  });
});
