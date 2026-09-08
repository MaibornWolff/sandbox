import { describe, expect, test } from "bun:test";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { getExitCodeForSignal } from "./exit-code.js";
import type {
  ProcessAdapter,
  ProcessIdentity,
  StartedProcess,
  StartedStreamingProcess,
} from "./process-adapter.js";
import {
  createProcessManager,
  runWithProcessManager,
} from "./process-lifecycle.js";
import type {
  ProcessResult,
  StandardProcessRequest,
  StartProcessRequest,
  StreamingProcessRequest,
} from "./process-manager.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface ProcessController {
  readonly signals: NodeJS.Signals[];
  readonly result: Deferred<ProcessResult>;
  readonly exited: Deferred<void>;
  running: boolean;
  unrefs: number;
  onSignal?: (signal: NodeJS.Signals) => void;
  exit(options?: {
    readonly signal?: NodeJS.Signals;
    readonly exitCode?: number;
  }): void;
  rejectResult(error: Error): void;
  disappear(): void;
}

function createController(): ProcessController {
  const result = deferred<ProcessResult>();
  const exited = deferred<void>();
  return {
    signals: [],
    result,
    exited,
    running: true,
    unrefs: 0,
    exit(options = {}) {
      this.running = false;
      result.resolve({
        exitCode:
          options.exitCode ??
          (options.signal ? getExitCodeForSignal(options.signal) : 0),
        ...(options.signal ? { signal: options.signal } : {}),
        stdout: "",
        stderr: "",
      });
      exited.resolve();
    },
    rejectResult(error) {
      result.reject(error);
    },
    disappear() {
      this.running = false;
      exited.resolve();
    },
  };
}

function createFixture() {
  const clock = createTestClock();
  const queued: ProcessController[] = [];
  const errors: string[] = [];
  const diagnostics: string[] = [];
  const controllers = new Map<number, ProcessController>();
  const captured = new Map<
    number,
    { readonly controller: ProcessController; token: string }
  >();
  let nextPid = 1_000;
  let listeners = 0;
  let signalListener: ((signal: NodeJS.Signals) => void) | undefined;
  let title = "original";
  function start(request: StreamingProcessRequest): StartedStreamingProcess;
  function start(request: StandardProcessRequest): StartedProcess;
  function start(
    request: StartProcessRequest,
  ): StartedProcess | StartedStreamingProcess {
    const controller = queued.shift();
    if (!controller) throw new Error("No process controller queued.");
    const pid = nextPid++;
    controllers.set(pid, controller);
    const identity = { pid, token: controller };
    const started = {
      identity,
      result: controller.result.promise,
      exited: controller.exited.promise,
    };
    if (request.stdio !== "stream") return started;
    const output: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            await controller.exited.promise;
            return { done: true, value: undefined };
          },
        };
      },
    };
    return {
      ...started,
      result: started.result.then(({ exitCode, signal }) => ({
        exitCode,
        ...(signal ? { signal } : {}),
      })),
      stdin: {
        write: async () => undefined,
        end: async () => undefined,
      },
      stdout: output,
      stderr: output,
    };
  }
  const adapter: ProcessAdapter = {
    start,
    capture(pid) {
      const process = captured.get(pid);
      return process?.controller.running
        ? { status: "captured", identity: { pid, token: process.token } }
        : { status: "missing" };
    },
    identityStatus(identity: ProcessIdentity) {
      const external = captured.get(identity.pid);
      if (external) {
        if (!external.controller.running) return "missing";
        return external.token === identity.token ? "running" : "changed";
      }
      const controller = controllers.get(identity.pid);
      return controller?.running ? "running" : "missing";
    },
    signal(identity, signal) {
      const controller =
        captured.get(identity.pid)?.controller ?? controllers.get(identity.pid);
      if (!controller) throw new Error(`Unknown process ${identity.pid}.`);
      controller.signals.push(signal);
      controller.onSignal?.(signal);
    },
    unref(identity) {
      const controller =
        captured.get(identity.pid)?.controller ?? controllers.get(identity.pid);
      if (controller) controller.unrefs += 1;
    },
    subscribeToSignals(_signals, listener) {
      listeners += 1;
      signalListener = listener;
      return () => {
        listeners -= 1;
        signalListener = undefined;
      };
    },
    setTitle(nextTitle) {
      const previous = title;
      title = nextTitle;
      return () => {
        title = previous;
      };
    },
  };
  const manager = createProcessManager({
    adapter,
    clock: clock.clock,
    logger: {
      debug: (message) => diagnostics.push(message),
      warn: () => undefined,
      error: (message) => errors.push(message),
    },
  });
  return {
    clock,
    manager,
    queue(controller = createController()) {
      queued.push(controller);
      return controller;
    },
    capture(controller = createController(), pid = 2_000) {
      captured.set(pid, { controller, token: "identity-1" });
      return controller;
    },
    changeCapturedIdentity(pid = 2_000) {
      const process = captured.get(pid);
      if (process) process.token = "identity-2";
    },
    listeners: () => listeners,
    title: () => title,
    errors: () => [...errors],
    diagnostics: () => [...diagnostics],
    emitSignal(signal: NodeJS.Signals) {
      signalListener?.(signal);
    },
  };
}

function startApplication(
  fixture: ReturnType<typeof createFixture>,
  name: string,
) {
  return fixture.manager.start({
    name,
    command: name,
    lifetime: "application",
    interaction: { mode: "non-interactive" },
    stdio: "ignore",
  });
}

function createManagedContractTarget(
  fixture: ReturnType<typeof createFixture>,
  source: "started" | "captured",
) {
  if (source === "started") {
    const controller = fixture.queue();
    return { controller, managed: startApplication(fixture, source) };
  }
  const controller = fixture.capture();
  const managed = fixture.manager.capture({ name: source, pid: 2_000 });
  if (!managed) throw new Error("Expected captured process.");
  return { controller, managed };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("process lifecycle", () => {
  test("owns one application termination subscription until disposal", async () => {
    const fixture = createFixture();
    const termination = fixture.manager.termination;
    expect(fixture.manager.termination).toBe(termination);
    expect(fixture.listeners()).toBe(1);

    fixture.emitSignal("SIGTERM");
    await expect(termination).resolves.toBe("SIGTERM");
    await fixture.manager.dispose();
    expect(fixture.listeners()).toBe(0);
  });

  test("reports hangup as an application termination signal", async () => {
    const fixture = createFixture();
    const termination = fixture.manager.termination;

    fixture.emitSignal("SIGHUP");

    await expect(termination).resolves.toBe("SIGHUP");
    await fixture.manager.dispose();
  });

  test("retains interactive ownership until the real process exit", async () => {
    const fixture = createFixture();
    const controller = fixture.queue();
    const managed = fixture.manager.start({
      name: "interactive",
      command: "interactive",
      lifetime: "application",
      interaction: { mode: "interactive", title: "agent" },
      stdio: "inherit",
    });
    expect(fixture.title()).toBe("agent");
    expect(fixture.listeners()).toBe(1);

    controller.rejectResult(new Error("source failed"));
    await expect(managed.result).rejects.toThrow("source failed");
    expect(fixture.title()).toBe("agent");
    expect(() =>
      fixture.manager.start({
        name: "second",
        command: "second",
        lifetime: "application",
        interaction: { mode: "interactive" },
      }),
    ).toThrow("Another interactive process already owns the terminal.");

    fixture.emitSignal("SIGINT");
    await settle();
    expect(controller.signals).toEqual(["SIGINT"]);
    controller.disappear();
    await managed.exited;
    expect(fixture.title()).toBe("original");
  });

  test("falls back locally when external signal forwarding declines", async () => {
    const fixture = createFixture();
    const controller = fixture.queue();
    fixture.manager.start({
      name: "runtime",
      command: "runtime",
      lifetime: "application",
      interaction: {
        mode: "interactive",
        forwardSignal: async () => false,
      },
    });

    fixture.emitSignal("SIGINT");
    await settle();

    expect(controller.signals).toEqual(["SIGINT"]);
    controller.disappear();
  });

  test("falls back locally when external signal forwarding fails", async () => {
    const fixture = createFixture();
    const controller = fixture.queue();
    const nestedCause = new Error("runtime socket failed");
    const forwardingCause = new Error("container signal failed", {
      cause: nestedCause,
    });
    fixture.manager.start({
      name: "runtime",
      command: "runtime",
      lifetime: "application",
      interaction: {
        mode: "interactive",
        forwardSignal: async () => {
          throw forwardingCause;
        },
      },
    });

    fixture.emitSignal("SIGTERM");
    await settle();
    expect(controller.signals).toEqual(["SIGTERM"]);
    expect(fixture.errors()).toEqual([
      "Failed to forward SIGTERM for runtime: container signal failed",
    ]);
    const diagnostics = fixture.diagnostics().join("\n");
    expect(diagnostics).toContain(forwardingCause.stack as string);
    expect(diagnostics).toContain(nestedCause.stack as string);
    controller.disappear();
  });

  test("forces once and suppresses stale graceful fallback", async () => {
    const fixture = createFixture();
    const controller = fixture.queue();
    const gracefulForwarding = deferred<boolean>();
    const forwarded: NodeJS.Signals[] = [];
    fixture.manager.start({
      name: "runtime",
      command: "runtime",
      lifetime: "application",
      interaction: {
        mode: "interactive",
        forwardSignal(signal) {
          forwarded.push(signal);
          return signal === "SIGTERM"
            ? gracefulForwarding.promise
            : Promise.resolve(true);
        },
      },
    });

    fixture.emitSignal("SIGTERM");
    fixture.emitSignal("SIGTERM");
    fixture.emitSignal("SIGTERM");
    await settle();
    expect(forwarded).toEqual(["SIGTERM", "SIGKILL"]);
    expect(controller.signals).toEqual([]);

    gracefulForwarding.reject(new Error("late graceful failure"));
    await settle();
    expect(controller.signals).toEqual([]);
    controller.disappear();
  });

  test("falls back locally when forced external forwarding fails", async () => {
    const fixture = createFixture();
    const controller = fixture.queue();
    fixture.manager.start({
      name: "runtime",
      command: "runtime",
      lifetime: "application",
      interaction: {
        mode: "interactive",
        forwardSignal: async (signal) => {
          if (signal === "SIGKILL") throw new Error("forced forwarding failed");
          return true;
        },
      },
    });

    fixture.emitSignal("SIGTERM");
    fixture.emitSignal("SIGTERM");
    await settle();
    expect(controller.signals).toEqual(["SIGKILL"]);
    controller.disappear();
  });

  test("keeps a process managed when its result rejects before real exit", async () => {
    const fixture = createFixture();
    const controller = fixture.queue();
    const managed = startApplication(fixture, "daemon");
    controller.rejectResult(new Error("source failed"));

    await expect(managed.result).rejects.toThrow("source failed");
    let exited = false;
    void managed.exited.then(() => {
      exited = true;
    });
    await settle();
    expect(exited).toBe(false);

    const stopping = managed.stop();
    expect(controller.signals).toEqual(["SIGTERM"]);
    controller.disappear();
    await expect(stopping).resolves.toEqual({});
    expect(fixture.clock.pendingSleeps()).toBe(0);
  });

  test("performs bounded graceful and forced termination", async () => {
    const fixture = createFixture();
    const controller = fixture.queue();
    const managed = startApplication(fixture, "daemon");
    const stopping = managed.stop();
    expect(managed.stop()).toBe(stopping);
    expect(controller.signals).toEqual(["SIGTERM"]);

    await fixture.clock.waitForSleep();
    await fixture.clock.advanceBy(5_000);
    await settle();
    expect(controller.signals).toEqual(["SIGTERM", "SIGKILL"]);
    controller.exit({ signal: "SIGKILL" });

    await expect(stopping).resolves.toEqual({
      exitCode: 137,
      signal: "SIGKILL",
    });
    await expect(managed.dispose()).resolves.toBeUndefined();
    await expect(managed[Symbol.asyncDispose]()).resolves.toBeUndefined();
    expect(fixture.clock.pendingSleeps()).toBe(0);
  });

  test("uses the same managed lifecycle for captured identities", async () => {
    const fixture = createFixture();
    expect(
      fixture.manager.capture({ name: "missing", pid: 9_999 }),
    ).toBeUndefined();
    const controller = fixture.capture();
    const managed = fixture.manager.capture({ name: "session", pid: 2_000 });
    if (!managed) throw new Error("Expected captured process.");
    expect("pid" in managed).toBe(false);

    const stopping = managed.stop({ signal: "SIGINT" });
    expect(controller.signals).toEqual(["SIGINT"]);
    controller.disappear();
    await fixture.clock.advanceBy(50);
    await expect(stopping).resolves.toMatchObject({});
    await expect(managed.result).resolves.toEqual({ reason: "disappeared" });
  });

  for (const source of ["started", "captured"] as const) {
    test(`${source} process shares graceful stop and idempotent disposal`, async () => {
      const fixture = createFixture();
      const { controller, managed } = createManagedContractTarget(
        fixture,
        source,
      );
      const stopping = managed.stop();
      expect(managed.stop()).toBe(stopping);
      expect(controller.signals).toEqual(["SIGTERM"]);
      controller.disappear();
      await fixture.clock.advanceBy(50);
      await expect(stopping).resolves.toEqual({});
      await expect(managed.dispose()).resolves.toBeUndefined();
      await expect(managed[Symbol.asyncDispose]()).resolves.toBeUndefined();
      expect(fixture.clock.pendingSleeps()).toBe(0);
    });

    test(`${source} process shares forced stop and survivor behavior`, async () => {
      const fixture = createFixture();
      const { controller, managed } = createManagedContractTarget(
        fixture,
        source,
      );
      const stopping = managed.stop();
      await fixture.clock.waitForSleep();
      await fixture.clock.advanceBy(5_000);
      await settle();
      expect(controller.signals).toEqual(["SIGTERM", "SIGKILL"]);
      await fixture.clock.waitForSleep();
      await fixture.clock.advanceBy(5_000);
      await expect(stopping).rejects.toMatchObject({
        name: "ProcessShutdownError",
        targets: [{ name: source, phase: "forced" }],
      });
      expect(controller.unrefs).toBe(1);
    });
  }

  test("never signals a captured PID that disappeared before stop", async () => {
    const fixture = createFixture();
    const controller = fixture.capture();
    const managed = fixture.manager.capture({ name: "session", pid: 2_000 });
    if (!managed) throw new Error("Expected captured process.");
    controller.running = false;

    await expect(managed.stop()).resolves.toEqual({});
    expect(controller.signals).toEqual([]);
  });

  test("never force-signals a captured PID after its identity changes", async () => {
    const fixture = createFixture();
    const controller = fixture.capture();
    const managed = fixture.manager.capture({ name: "session", pid: 2_000 });
    if (!managed) throw new Error("Expected captured process.");
    controller.onSignal = (signal) => {
      if (signal === "SIGTERM") fixture.changeCapturedIdentity();
    };

    const stopping = managed.stop();
    await fixture.clock.advanceBy(50);
    await expect(stopping).rejects.toThrow("changed operating-system identity");
    expect(controller.signals).toEqual(["SIGTERM"]);
  });

  test("rejects a captured PID whose stable identity changes", async () => {
    const fixture = createFixture();
    fixture.capture();
    const managed = fixture.manager.capture({ name: "session", pid: 2_000 });
    if (!managed) throw new Error("Expected captured process.");
    await fixture.clock.waitForSleep();
    fixture.changeCapturedIdentity();
    await fixture.clock.advanceBy(50);

    await expect(managed.result).rejects.toThrow(
      "changed operating-system identity",
    );
    await expect(managed.exited).rejects.toThrow(
      "changed operating-system identity",
    );
  });

  test("treats a missing identity as already exited without signalling", async () => {
    const fixture = createFixture();
    const controller = fixture.queue();
    const managed = startApplication(fixture, "gone");
    controller.disappear();

    await expect(managed.stop()).resolves.toEqual({});
    expect(controller.signals).toEqual([]);
  });

  test("reports and unreferences a survivor after SIGKILL", async () => {
    const fixture = createFixture();
    const controller = fixture.queue();
    const stopping = startApplication(fixture, "survivor").stop();
    await fixture.clock.waitForSleep();
    await fixture.clock.advanceBy(5_000);
    await fixture.clock.waitForSleep();
    await fixture.clock.advanceBy(5_000);

    await expect(stopping).rejects.toMatchObject({
      name: "ProcessShutdownError",
      targets: [{ name: "survivor", pid: 1_000, phase: "forced" }],
    });
    expect(controller.unrefs).toBe(1);
  });

  test("aggregates multiple survivors in one stopAll failure", async () => {
    const fixture = createFixture();
    const first = fixture.queue();
    const second = fixture.queue();
    startApplication(fixture, "first");
    startApplication(fixture, "second");
    const stopping = fixture.manager.stopAll();

    await fixture.clock.waitForSleep();
    await fixture.clock.advanceBy(5_000);
    await settle();
    await fixture.clock.waitForSleep();
    await fixture.clock.advanceBy(5_000);

    await expect(stopping).rejects.toMatchObject({
      name: "ProcessShutdownError",
      targets: [
        { name: "first", pid: 1_000, phase: "forced" },
        { name: "second", pid: 1_001, phase: "forced" },
      ],
    });
    expect(first.unrefs).toBe(1);
    expect(second.unrefs).toBe(1);
  });

  test("unrefs detached processes and excludes them from manager disposal", async () => {
    const fixture = createFixture();
    const controller = fixture.queue();
    const managed = fixture.manager.start({
      name: "editor",
      command: "editor",
      lifetime: "detached",
      interaction: { mode: "non-interactive" },
      stdio: "ignore",
    });
    const explicitController = fixture.queue();
    const explicit = fixture.manager.start({
      name: "other-editor",
      command: "other-editor",
      lifetime: "detached",
      interaction: { mode: "non-interactive" },
      stdio: "ignore",
    });
    expect(controller.unrefs).toBe(1);

    void fixture.manager.termination;
    expect(fixture.listeners()).toBe(1);
    await fixture.manager.dispose();
    expect(controller.signals).toEqual([]);
    expect(controller.running).toBe(true);
    expect(fixture.listeners()).toBe(0);

    const explicitStop = explicit.stop();
    expect(explicitController.signals).toEqual(["SIGTERM"]);
    explicitController.disappear();
    await explicitStop;

    controller.exit();
    await expect(managed.result).resolves.toMatchObject({ exitCode: 0 });
    await expect(managed.exited).resolves.toEqual({});
  });

  test("freezes starts during stopAll and reopens after the generation", async () => {
    const fixture = createFixture();
    const first = fixture.queue();
    startApplication(fixture, "first");
    let lateStartError: unknown;
    first.onSignal = () => {
      try {
        startApplication(fixture, "late");
      } catch (error) {
        lateStartError = error;
      }
      first.exit({ signal: "SIGTERM" });
    };

    await fixture.manager.stopAll();
    expect(lateStartError).toBeInstanceOf(Error);
    expect((lateStartError as Error).message).toContain(
      "stopping generation 1",
    );

    const cleanup = fixture.queue();
    const managedCleanup = startApplication(fixture, "cleanup");
    cleanup.exit();
    await expect(managedCleanup.exited).resolves.toMatchObject({ exitCode: 0 });
  });

  test("preserves original stack and cause through shutdown errors", async () => {
    const fixture = createFixture();
    const controller = fixture.queue();
    const rootCause = new Error("root cause");
    const sentinel = new Error("signal failed", { cause: rootCause });
    controller.onSignal = () => {
      throw sentinel;
    };

    const stopping = startApplication(fixture, "failing").stop();
    try {
      await stopping;
      expect.unreachable("stop should fail");
    } catch (error) {
      expect(error).toMatchObject({
        name: "ProcessShutdownError",
        cause: sentinel,
        targets: [
          { name: "failing", pid: 1_000, phase: "graceful", error: sentinel },
        ],
      });
      expect((error as Error).stack).toContain("ProcessShutdownError");
      expect((error as Error & { cause: Error }).cause.stack).toBe(
        sentinel.stack,
      );
      expect(sentinel.cause).toBe(rootCause);
    }
  });

  test("preserves a primary operation error with structured disposal details", async () => {
    const primary = new Error("operation failed", {
      cause: new Error("operation cause"),
    });
    const disposal = new Error("disposal failed", {
      cause: new Error("disposal cause"),
    });
    const manager = {
      termination: new Promise<NodeJS.Signals>(() => undefined),
      start: () => {
        throw new Error("unused");
      },
      capture: () => undefined,
      stopAll: async () => undefined,
      dispose: async () => {
        throw disposal;
      },
      [Symbol.asyncDispose]: async () => undefined,
    };

    try {
      await runWithTestLogger(() =>
        runWithProcessManager(manager, async () => {
          throw primary;
        }),
      );
      expect.unreachable("operation should fail");
    } catch (error) {
      expect(error).toBe(primary);
      expect(primary.stack).toContain("operation failed");
      expect(
        (error as Error & { suppressedErrors: readonly unknown[] })
          .suppressedErrors,
      ).toMatchObject([
        {
          name: "ProcessCleanupError",
          cause: disposal,
          suppressedErrors: [disposal],
        },
      ]);
    }
  });

  test("permanently rejects starts after repeated disposal", async () => {
    const fixture = createFixture();
    await fixture.manager.dispose();
    await fixture.manager.dispose();
    await fixture.manager[Symbol.asyncDispose]();
    expect(() => startApplication(fixture, "late")).toThrow(
      "Process manager is disposed",
    );
    expect(fixture.clock.pendingSleeps()).toBe(0);
  });
});
