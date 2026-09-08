import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createHostEnvironment,
  provideHostEnvironment,
} from "#platform/environment/index.js";
import { type Logger, provideLogger } from "#platform/logging/index.js";
import { createProcessTestHarness } from "#platform/process/__test__/index.js";
import { provideProcessManager } from "#platform/process/index.js";
import { createTestTerminal } from "#platform/terminal/__test__/index.js";
import { provideTerminal } from "#platform/terminal/index.js";
import {
  createNodeWebSocketService,
  provideWebSocketService,
  type WebSocketConnection,
  type WebSocketMessage,
} from "#platform/websocket/index.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { runHostCommandEscape } from "./client.js";
import type { CommandPattern } from "./matchers.js";
import {
  decodeBinaryChannel,
  encodeBinaryChannel,
  encodeControlMessage,
  HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE,
  HOST_COMMAND_ESCAPE_MAX_MESSAGE_BYTES,
  HOST_COMMAND_ESCAPE_PROTOCOL,
  HOST_COMMAND_ESCAPE_PROTOCOL_VARIABLE,
  HOST_COMMAND_ESCAPE_TOKEN_VARIABLE,
  parseBrokerControlMessage,
  STREAM_CHANNEL,
} from "./protocol.js";
import {
  type HostCommandEscapeSession,
  startHostCommandEscapeSession,
} from "./session.js";

interface SessionFixture extends AsyncDisposable {
  readonly root: string;
  readonly hostProjectRoot: string;
  readonly processes: ReturnType<typeof createProcessTestHarness>;
  readonly session: HostCommandEscapeSession;
  disposeSession(): Promise<void>;
  connect(options?: {
    readonly token?: string;
    readonly protocol?: string;
  }): Promise<WebSocketConnection>;
}

async function createSessionFixture(
  rules: readonly CommandPattern[] = [
    ["tool", { repeat: { regex: ".*" }, min: 0, max: 10 }],
  ],
  errorLogs: string[] = [],
): Promise<SessionFixture> {
  const root = createTestDir("host-command-session");
  const hostProjectRoot = path.join(root, "project");
  fs.mkdirSync(path.join(hostProjectRoot, "nested"), { recursive: true });
  const processes = createProcessTestHarness();
  const webSockets = createNodeWebSocketService();
  const environment = createHostEnvironment({
    currentWorkingDirectory: hostProjectRoot,
    homeDirectory: root,
    variables: { HOST_ONLY: "unchanged", PATH: process.env.PATH ?? "" },
    platform: process.platform,
    interactive: false,
  });
  const logger: Logger = {
    success: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message) => errorLogs.push(message),
    debug: () => undefined,
    startTiming: () => undefined,
    endTiming: () => undefined,
    setVerbose: () => undefined,
    setSilent: () => undefined,
  };
  const dependencies = [
    provideHostEnvironment(environment),
    provideProcessManager(processes.manager),
    provideWebSocketService(webSockets),
    provideLogger(logger),
  ];
  let session: HostCommandEscapeSession;
  try {
    session = await runWithDependencies(dependencies, () =>
      startHostCommandEscapeSession({
        commandRules: rules,
        hostProjectRoot,
        containerProjectRoot: "/workspace",
        containerHostName: "host.docker.internal",
      }),
    );
  } catch (error) {
    await processes.dispose();
    cleanupTestDir(root);
    throw error;
  }
  const endpoint =
    session.clientEnvironment[HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE];
  const token = session.clientEnvironment[HOST_COMMAND_ESCAPE_TOKEN_VARIABLE];
  if (!endpoint || !token)
    throw new Error("Session client environment is incomplete.");
  const localEndpoint = endpoint.replace("host.docker.internal", "127.0.0.1");
  return {
    root,
    hostProjectRoot,
    processes,
    session,
    disposeSession: () =>
      Promise.resolve(
        runWithDependencies(dependencies, () => session[Symbol.asyncDispose]()),
      ),
    connect: (options = {}) =>
      webSockets.connect({
        url: localEndpoint,
        protocol: options.protocol ?? HOST_COMMAND_ESCAPE_PROTOCOL,
        maxMessageBytes: HOST_COMMAND_ESCAPE_MAX_MESSAGE_BYTES,
        headers: { authorization: `Bearer ${options.token ?? token}` },
      }),
    async [Symbol.asyncDispose]() {
      await runWithDependencies(dependencies, () =>
        session[Symbol.asyncDispose](),
      );
      await processes.dispose();
      cleanupTestDir(root);
    },
  };
}

function messageIterator(
  connection: WebSocketConnection,
): AsyncIterator<WebSocketMessage> {
  return connection.messages[Symbol.asyncIterator]();
}

async function nextMessage(
  iterator: AsyncIterator<WebSocketMessage>,
): Promise<WebSocketMessage> {
  const next = await iterator.next();
  if (next.done)
    throw new Error("Connection ended before the expected message.");
  return next.value;
}

async function nextControl(iterator: AsyncIterator<WebSocketMessage>) {
  const message = await nextMessage(iterator);
  if (message.type !== "text") throw new Error("Expected a control message.");
  return parseBrokerControlMessage(message.data);
}

async function startExecute(
  connection: WebSocketConnection,
  argv: readonly string[] = ["tool", "argument"],
  cwd = "/workspace/nested",
): Promise<AsyncIterator<WebSocketMessage>> {
  const iterator = messageIterator(connection);
  await connection.sendText(
    encodeControlMessage({ type: "execute", argv, cwd }),
  );
  expect(await nextControl(iterator)).toEqual({ type: "ready" });
  return iterator;
}

async function collectUntilExit(
  iterator: AsyncIterator<WebSocketMessage>,
): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}> {
  let stdout = "";
  let stderr = "";
  for (;;) {
    const message = await nextMessage(iterator);
    if (message.type === "binary") {
      const binary = decodeBinaryChannel(message.data);
      if (binary.channel === STREAM_CHANNEL.stdout)
        stdout += Buffer.from(binary.payload).toString();
      if (binary.channel === STREAM_CHANNEL.stderr)
        stderr += Buffer.from(binary.payload).toString();
      continue;
    }
    const control = parseBrokerControlMessage(message.data);
    if (control.type === "exit")
      return { stdout, stderr, exitCode: control.exitCode };
  }
}

describe("host command escape session", () => {
  test("authenticates upgrades and returns the host configuration snapshot", async () => {
    await using fixture = await createSessionFixture([
      ["tool", [["safe", { regex: "profile-[0-9]+" }]]],
      [
        "batch",
        {
          repeat: ["item", { regex: "value-[0-9]+" }],
          min: 1,
          max: 2,
        },
      ],
    ]);
    expect(Object.keys(fixture.session.clientEnvironment).sort()).toEqual(
      [
        HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE,
        HOST_COMMAND_ESCAPE_PROTOCOL_VARIABLE,
        HOST_COMMAND_ESCAPE_TOKEN_VARIABLE,
      ].sort(),
    );
    await expect(fixture.connect({ token: "invalid" })).rejects.toThrow();
    await expect(
      fixture.connect({ protocol: "unsupported.v2" }),
    ).rejects.toThrow();

    await using connection = await fixture.connect();
    const iterator = messageIterator(connection);
    await connection.sendText(encodeControlMessage({ type: "list" }));
    expect(await nextControl(iterator)).toEqual({
      type: "allowed-commands",
      patterns: [
        '["tool",[["safe",{"regex":"profile-[0-9]+"}]]]',
        '["batch",{"repeat":["item",{"regex":"value-[0-9]+"}],"min":1,"max":2}]',
      ],
    });
    expect(fixture.processes.requests).toHaveLength(0);
  });

  test("enforces composable matchers against the complete argv", async () => {
    await using fixture = await createSessionFixture([
      ["tool", [["safe", { regex: "profile-[0-9]+" }]]],
      [
        "batch",
        {
          repeat: ["item", { regex: "value-[0-9]+" }],
          min: 1,
          max: 2,
        },
      ],
      ["wild", "?", "*", "done"],
    ]);
    const allowed = [
      ["tool", "safe"],
      ["tool", "profile-12"],
      ["batch", "item"],
      ["batch", "value-1", "item"],
      ["wild", "one", "done"],
      ["wild", "one", "two", "three", "done"],
    ] as const;
    for (const argv of allowed) {
      const child = fixture.processes.expectStart({
        match: { command: argv[0] },
      });
      await using connection = await fixture.connect();
      const messages = await startExecute(connection, argv);
      await child.waitForStart();
      child.exit({ exitCode: 0 });
      expect((await collectUntilExit(messages)).exitCode).toBe(0);
    }

    const denied = [
      ["tool", "profile-x"],
      ["tool", "safe", "trailing"],
      ["batch"],
      ["batch", "item", "value-2", "item"],
      ["wild", "done"],
      ["wild", "one", "two"],
    ] as const;
    for (const argv of denied) {
      await using connection = await fixture.connect();
      const iterator = messageIterator(connection);
      await connection.sendText(
        encodeControlMessage({ type: "execute", argv, cwd: "/workspace" }),
      );
      expect((await collectUntilExit(iterator)).exitCode).toBe(126);
    }
    expect(fixture.processes.requests).toHaveLength(allowed.length);
  });

  test("lists no patterns and denies execution for an empty policy", async () => {
    await using fixture = await createSessionFixture([]);
    await using listConnection = await fixture.connect();
    const listMessages = messageIterator(listConnection);
    await listConnection.sendText(encodeControlMessage({ type: "list" }));
    expect(await nextControl(listMessages)).toEqual({
      type: "allowed-commands",
      patterns: [],
    });

    await using executeConnection = await fixture.connect();
    const executeMessages = messageIterator(executeConnection);
    await executeConnection.sendText(
      encodeControlMessage({
        type: "execute",
        argv: ["tool"],
        cwd: "/workspace",
      }),
    );
    expect((await collectUntilExit(executeMessages)).exitCode).toBe(126);
    expect(fixture.processes.requests).toHaveLength(0);
  });

  test("reports an unexpected policy compilation failure before startup", async () => {
    const errorLogs: string[] = [];
    await expect(
      createSessionFixture([["tool", { regex: "(" }]], errorLogs),
    ).rejects.toThrow("Host command escape policy compilation failed.");
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toContain(
      "Failed to compile host command escape policy: pattern[1].regex",
    );
  });

  test("denies unauthorized commands before process creation", async () => {
    await using fixture = await createSessionFixture([["tool", "safe"]]);
    await using connection = await fixture.connect();
    const iterator = messageIterator(connection);
    await connection.sendText(
      encodeControlMessage({
        type: "execute",
        argv: ["tool", "secret"],
        cwd: "/workspace",
      }),
    );
    const result = await collectUntilExit(iterator);
    expect(result).toEqual({
      stdout: "",
      stderr: "sandbox escape: command is not allowed: tool secret\n",
      exitCode: 126,
    });
    expect(fixture.processes.requests).toHaveLength(0);
  });

  test("maps the directory and streams separate channels with stdin backpressure", async () => {
    await using fixture = await createSessionFixture();
    const child = fixture.processes.expectStart({
      match: { command: "tool", stdio: "stream" },
    });
    await using connection = await fixture.connect();
    const iterator = await startExecute(connection, ["tool", "first second"]);
    const request = await child.waitForStart();
    expect(request).toMatchObject({
      command: "tool",
      args: ["first second"],
      cwd: path.join(fixture.hostProjectRoot, "nested"),
      env: { HOST_ONLY: "unchanged", PATH: process.env.PATH ?? "" },
      stdio: "stream",
    });

    await connection.sendBinary(
      encodeBinaryChannel(STREAM_CHANNEL.stdin, Buffer.from("input")),
    );
    expect(Buffer.from(await child.waitForInput()).toString()).toBe("input");
    await connection.sendText(encodeControlMessage({ type: "stdin-end" }));
    await child.waitForInputEnd();
    child.emitStdout("out");
    child.emitStderr("err");
    child.exit({ exitCode: 23 });
    expect(await collectUntilExit(iterator)).toEqual({
      stdout: "out",
      stderr: "err",
      exitCode: 23,
    });
  });

  test("spawns from the validated canonical directory", async () => {
    await using fixture = await createSessionFixture();
    const alias = path.join(fixture.hostProjectRoot, "alias");
    fs.symlinkSync(path.join(fixture.hostProjectRoot, "nested"), alias);
    const child = fixture.processes.expectStart({ match: { command: "tool" } });
    await using connection = await fixture.connect();
    const messages = await startExecute(
      connection,
      ["tool"],
      "/workspace/alias",
    );

    const request = await child.waitForStart();
    fs.rmSync(alias);
    fs.symlinkSync(path.join(fixture.root, "outside"), alias);

    expect(request.cwd).toBe(path.join(fixture.hostProjectRoot, "nested"));
    child.exit({ exitCode: 0 });
    expect((await collectUntilExit(messages)).exitCode).toBe(0);
  });

  test("rejects traversal, missing paths, symlink escapes, and invalid protocol data", async () => {
    await using fixture = await createSessionFixture();
    const outside = path.join(fixture.root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(fixture.hostProjectRoot, "escape"));
    for (const cwd of ["/outside", "/workspace/missing", "/workspace/escape"]) {
      await using connection = await fixture.connect();
      const iterator = messageIterator(connection);
      await connection.sendText(
        encodeControlMessage({ type: "execute", argv: ["tool"], cwd }),
      );
      expect((await collectUntilExit(iterator)).exitCode).toBe(126);
    }
    await using malformed = await fixture.connect();
    await malformed.sendText('{"type":"execute","argv":[],"cwd":"/workspace"}');
    expect(await nextControl(messageIterator(malformed))).toMatchObject({
      type: "error",
      code: "PROTOCOL_ERROR",
    });

    await using invalidChannel = await fixture.connect();
    await invalidChannel.sendBinary(Uint8Array.of(9, 1));
    expect(await nextControl(messageIterator(invalidChannel))).toMatchObject({
      type: "error",
      code: "PROTOCOL_ERROR",
    });

    await using oversized = await fixture.connect();
    await oversized.sendBinary(
      new Uint8Array(HOST_COMMAND_ESCAPE_MAX_MESSAGE_BYTES + 1),
    );
    expect((await oversized.closed).code).toBe(1009);
    expect(fixture.processes.requests).toHaveLength(0);
  });

  test("isolates concurrent processes and stops children on disconnect and disposal", async () => {
    await using fixture = await createSessionFixture();
    const firstChild = fixture.processes.expectStart({
      match: { command: "tool" },
    });
    const secondChild = fixture.processes.expectStart({
      match: { command: "tool" },
    });
    firstChild.exitOnSignal();
    secondChild.exitOnSignal();
    await using first = await fixture.connect();
    await using second = await fixture.connect();
    await startExecute(first, ["tool", "first"]);
    await startExecute(second, ["tool", "second"]);
    const requests = await Promise.all([
      firstChild.waitForStart(),
      secondChild.waitForStart(),
    ]);
    expect(requests.map((request) => request.args?.[0]).sort()).toEqual([
      "first",
      "second",
    ]);

    await first.close();
    expect(
      await Promise.race([
        firstChild.waitForSignal(),
        secondChild.waitForSignal(),
      ]),
    ).toBe("SIGTERM");
    await fixture.disposeSession();
    expect(await firstChild.waitForSignal()).toBe("SIGTERM");
    expect(await secondChild.waitForSignal()).toBe("SIGTERM");
  });

  test("runs the container client with host environment and terminal resources", async () => {
    await using fixture = await createSessionFixture();
    const child = fixture.processes.expectStart({ match: { command: "tool" } });
    const terminal = createTestTerminal();
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => terminal.dispose());
    const endpoint = fixture.session.clientEnvironment[
      HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE
    ]?.replace("host.docker.internal", "127.0.0.1");
    const token =
      fixture.session.clientEnvironment[HOST_COMMAND_ESCAPE_TOKEN_VARIABLE];
    if (!endpoint || !token) throw new Error("Missing client environment.");
    const clientEnvironment = createHostEnvironment({
      currentWorkingDirectory: "/workspace/nested",
      homeDirectory: "/home/container",
      variables: {
        [HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE]: endpoint,
        [HOST_COMMAND_ESCAPE_PROTOCOL_VARIABLE]: HOST_COMMAND_ESCAPE_PROTOCOL,
        [HOST_COMMAND_ESCAPE_TOKEN_VARIABLE]: token,
        CONTAINER_ONLY: "not-forwarded",
      },
      platform: "linux",
      interactive: false,
    });
    const running = runWithDependencies(
      [
        provideHostEnvironment(clientEnvironment),
        provideProcessManager(fixture.processes.manager),
        provideTerminal(terminal.io),
        provideWebSocketService(createNodeWebSocketService()),
      ],
      () =>
        runHostCommandEscape({
          operation: "execute",
          argv: ["tool", "NAME=value"],
        }),
    );
    const request = await child.waitForStart();
    expect(request.args).toEqual(["NAME=value"]);
    expect(request.env).toEqual({
      HOST_ONLY: "unchanged",
      PATH: process.env.PATH ?? "",
    });
    child.emitStdout("client-out");
    child.emitStderr("client-err");
    child.exit({ exitCode: 0 });
    await running;
    expect(terminal.stdout()).toBe("client-out");
    expect(terminal.stderr()).toBe("client-err");
  });

  test("forwards the container CLI termination signal to the host child", async () => {
    await using fixture = await createSessionFixture();
    const child = fixture.processes.expectStart({ match: { command: "tool" } });
    child.exitOnSignal("SIGINT");
    const terminal = createTestTerminal();
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => terminal.dispose());
    const endpoint = fixture.session.clientEnvironment[
      HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE
    ]?.replace("host.docker.internal", "127.0.0.1");
    const token =
      fixture.session.clientEnvironment[HOST_COMMAND_ESCAPE_TOKEN_VARIABLE];
    if (!endpoint || !token) throw new Error("Missing client environment.");
    const clientEnvironment = createHostEnvironment({
      currentWorkingDirectory: "/workspace",
      homeDirectory: "/home/container",
      variables: {
        [HOST_COMMAND_ESCAPE_ENDPOINT_VARIABLE]: endpoint,
        [HOST_COMMAND_ESCAPE_PROTOCOL_VARIABLE]: HOST_COMMAND_ESCAPE_PROTOCOL,
        [HOST_COMMAND_ESCAPE_TOKEN_VARIABLE]: token,
      },
      platform: "linux",
      interactive: false,
    });
    const running = runWithDependencies(
      [
        provideHostEnvironment(clientEnvironment),
        provideProcessManager(fixture.processes.manager),
        provideTerminal(terminal.io),
        provideWebSocketService(createNodeWebSocketService()),
      ],
      () =>
        runHostCommandEscape({
          operation: "execute",
          argv: ["tool"],
        }),
    );
    await child.waitForStart();

    fixture.processes.emitTermination("SIGINT");

    expect(await child.waitForSignal()).toBe("SIGINT");
    await expect(running).rejects.toMatchObject({ exitCode: 130 });
  });

  test("handles host signals only while an escaped child is active", async () => {
    await using fixture = await createSessionFixture();
    expect(await fixture.session.forwardSignal("SIGINT")).toBe(false);
    const child = fixture.processes.expectStart({ match: { command: "tool" } });
    child.exitOnSignal("SIGINT");
    await using connection = await fixture.connect();
    const messages = await startExecute(connection);

    expect(await fixture.session.forwardSignal("SIGINT")).toBe(true);

    expect(await child.waitForSignal()).toBe("SIGINT");
    expect((await collectUntilExit(messages)).exitCode).toBe(130);
  });

  test("declines host signal handling when every child signal fails", async () => {
    await using fixture = await createSessionFixture();
    const child = fixture.processes.expectStart({ match: { command: "tool" } });
    child.failSignalsWith(new Error("signal failed"));
    await using connection = await fixture.connect();
    const messages = await startExecute(connection);

    expect(await fixture.session.forwardSignal("SIGINT")).toBe(false);

    child.exit({ exitCode: 0 });
    expect((await collectUntilExit(messages)).exitCode).toBe(0);
  });

  test("forwards supported signals and maps missing executables to 127", async () => {
    await using fixture = await createSessionFixture();
    const signaled = fixture.processes.expectStart({
      match: { command: "tool" },
    });
    signaled.exitOnSignal("SIGINT");
    await using signalConnection = await fixture.connect();
    const signalMessages = await startExecute(signalConnection);
    await signalConnection.sendText(
      encodeControlMessage({ type: "signal", signal: "SIGINT" }),
    );
    expect(await signaled.waitForSignal()).toBe("SIGINT");
    expect((await collectUntilExit(signalMessages)).exitCode).toBe(130);

    const missing = fixture.processes.expectStart({
      match: { command: "tool" },
    });
    const missingError = Object.assign(new Error("spawn failed"), {
      code: "ENOENT",
    });
    await using missingConnection = await fixture.connect();
    const missingMessages = await startExecute(missingConnection);
    missing.rejectResult(missingError);
    expect((await collectUntilExit(missingMessages)).exitCode).toBe(127);
  });
});
