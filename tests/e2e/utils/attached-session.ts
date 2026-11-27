import { expect } from "bun:test";
import { chmod, copyFile, mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxInstance } from "./sandbox.js";

const bridge = fileURLToPath(
  new URL("../fixtures/attached-session-pty.py", import.meta.url),
);
type FixtureProcess = Omit<SandboxInstance["fixtureProcess"], "env"> & {
  env: NodeJS.ProcessEnv;
};

export function startPty(
  command: string[],
  options: Pick<FixtureProcess, "cwd" | "env">,
  stderrPath?: string,
) {
  const child = Bun.spawn(["python3", bridge, stderrPath ?? "-", ...command], {
    ...options,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const terminalOutput = new Response(child.stderr).text();
  let status: number | undefined;
  let bridgeError: Error | undefined;
  const result = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]).then(([exitCode, output]) => {
    const reported = output.trim();
    if (exitCode !== 0 || !/^-?\d+$/.test(reported)) {
      throw new Error(`PTY bridge exited with ${exitCode}: ${reported}`);
    }
    status = Number(reported);
    return status;
  });
  void result.catch((error: unknown) => {
    bridgeError = new Error("PTY bridge failed", { cause: error });
  });
  return {
    get status() {
      if (bridgeError) throw bridgeError;
      return status;
    },
    result,
    send(action: "C" | "H" | "T") {
      child.stdin.write(action);
      child.stdin.flush();
    },
    async diagnostics() {
      const redirected = stderrPath ? await readOptional(stderrPath) : "";
      return `${await terminalOutput}\n${redirected}`;
    },
    async [Symbol.asyncDispose]() {
      await child.stdin.end();
      await child.exited;
    },
  };
}

async function readOptional(path: string): Promise<string> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : "";
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeout: number,
  message: string,
): Promise<T> {
  const deadline = performance.now() + timeout;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(50);
  } while (performance.now() < deadline);
  throw new Error(message);
}

const probeScript = `
set -eu
stat=$(cat "/proc/$1/stat" 2>/dev/null) || stat=
if [ -n "$stat" ]; then
    set -- "$1" \${stat##*) }
    if [ "$2" != Z ]; then printf '%s\\n' "\${21}"; else echo absent; fi
else
    echo absent
fi
cat "/tmp/sandbox-sessions/$1" 2>/dev/null || echo absent
`;

const scenarios = [
  { label: "normal", exitCode: 42 },
  { label: "hup", action: "H", exitCode: 129 },
  { label: "term", action: "T", exitCode: 143 },
  { label: "verbose-close", action: "C", exitCode: 129 },
  { label: "redirected-close", action: "C", exitCode: 129, redirect: true },
] as const;

const repeatedHangupScenario = {
  label: "repeated-hup",
  action: "H",
  exitCode: 129,
  repeated: true,
} as const;

const timedOutStopScenario = {
  label: "timed-out-stop",
  action: "H",
  exitCode: 129,
  stopTimeout: true,
} as const;

const shellRootScenario = {
  label: "shell-root-close",
  action: "C",
  exitCode: 129,
  shellRoot: "wrapped",
} as const;

const unwrappedShellRootScenario = {
  ...shellRootScenario,
  shellRoot: "unwrapped",
} as const;

export type AttachedSessionScenario =
  | "standard"
  | "repeated-hangup"
  | "timed-out-stop"
  | "shell-root"
  | "shell-root-no-wrapper";

type Scenario =
  | (typeof scenarios)[number]
  | typeof repeatedHangupScenario
  | typeof timedOutStopScenario
  | typeof shellRootScenario
  | typeof unwrappedShellRootScenario;

async function traceLauncher(options: FixtureProcess, dir: string) {
  const received = join(dir, "received-hangups");
  const exited = join(dir, "launcher-exit");
  const preload = join(dir, "observe-hangups.cjs");
  // Observe dispatch without registering a signal handler of our own.
  await Bun.write(
    preload,
    `
const { appendFileSync, writeFileSync } = require("node:fs");
process.once("exit", (code) => writeFileSync(${JSON.stringify(exited)}, String(code)));
const emit = process.emit;
process.emit = function (name, ...args) {
  const result = emit.call(this, name, ...args);
  if (name === "SIGHUP" && result) {
    appendFileSync(${JSON.stringify(received)}, "SIGHUP\\n");
  }
  return result;
};
`,
  );
  return {
    env: {
      NODE_OPTIONS: `${options.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`,
    },
    received: () => readOptional(received),
    exited: () => readOptional(exited),
  };
}

async function createStopGate(
  options: FixtureProcess,
  configDir: string,
  mode: "timeout" | "stdin",
) {
  const gate = join(configDir, "stop-gate");
  await mkdir(gate);
  const shim = join(gate, "podman");
  await copyFile(
    new URL("../fixtures/guest-stop-gate.py", import.meta.url),
    shim,
  );
  await chmod(shim, 0o755);
  const ready = join(options.cwd, "guest-stop.ready");
  return {
    env: {
      PATH: `${gate}:${options.env.PATH ?? ""}`,
      E2E_REAL_PODMAN: unwrap(
        Bun.which("podman") ?? undefined,
        "Missing Podman",
      ),
      E2E_STOP_GATE: gate,
      E2E_STOP_GATE_MODE: mode,
      E2E_GUEST_STOP_READY: ready,
    },
    mode,
    target: (id: string) => Bun.write(join(gate, "target"), id),
    attempts: async () =>
      (await readdir(gate)).filter((name) => name.startsWith("attempt-"))
        .length,
    expired: () => Bun.file(join(gate, "expired")).exists(),
    ready: () => readOptional(ready),
    release: () => Bun.write(join(gate, "release"), ""),
  };
}

function unwrap(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function createFixture(options: FixtureProcess, configDir: string) {
  const file = (name: string) => join(options.cwd, name);

  async function podman(...args: string[]) {
    const child = Bun.spawn(["podman", ...args], {
      ...options,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 8_000,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(status, `Podman ${args.join(" ")}: ${stderr}`).toBe(0);
    return stdout.trim();
  }

  function launch(
    label: string,
    launchOptions?: {
      verbose?: boolean;
      redirect?: boolean;
      env?: Record<string, string>;
      shellRoot?: boolean;
      skipWrapper?: boolean;
    },
  ) {
    const command = [
      options.binary,
      ...(launchOptions?.verbose ? ["-v"] : []),
      "--no-build",
      "run",
      ...(launchOptions?.skipWrapper ? ["--no-wrapper"] : []),
      "--",
      "/bin/sh",
      "./guest.sh",
      label,
      label === "normal" ? "42" : "0",
    ];
    const pty = startPty(
      launchOptions?.shellRoot
        ? ["/bin/zsh", "-fic", '"$@"; exit $?', "zsh", ...command]
        : command,
      { ...options, env: { ...options.env, ...launchOptions?.env } },
      launchOptions?.redirect ? join(configDir, `${label}.stderr`) : undefined,
    );
    return Object.assign(pty, {
      async ready() {
        const text = await this.observe(
          async () => (await readOptional(file(`${label}.ready`))) || undefined,
          35_000,
          "guest did not become ready",
        );
        const [pid, id, worker] = text.trim().split(" ");
        return {
          pid: unwrap(pid, "Missing guest PID"),
          id: unwrap(id, "Missing session ID"),
          worker: unwrap(worker, "Missing guest worker PID"),
        };
      },
      async observe<T>(
        read: () => Promise<T | undefined>,
        timeout: number,
        message: string,
      ) {
        return waitFor(
          async () => {
            if (pty.status !== undefined) {
              throw new Error(`${label}: early exit ${pty.status}\n${message}`);
            }
            return read();
          },
          timeout,
          `${label}: ${message}`,
        );
      },
      async exited() {
        return waitFor(
          async () => pty.status,
          12_000,
          `${label}: CLI did not exit`,
        );
      },
    });
  }

  async function probe(container: string, pid: string) {
    const output = await podman(
      "exec",
      container,
      "/bin/sh",
      "-c",
      probeScript,
      "probe",
      pid,
    );
    const lineEnd = output.indexOf("\n");
    if (lineEnd < 0) throw new Error(`Invalid guest probe output: ${output}`);
    const startTime = output.slice(0, lineEnd);
    const record = output.slice(lineEnd + 1);
    const fields = record.split("\0");
    if (record !== "absent" && fields.pop() !== "") {
      throw new Error("Guest session marker is not zero-terminated");
    }
    return {
      startTime: unwrap(startTime, "Missing guest process observation"),
      marker: unwrap(fields[0], "Missing guest marker observation"),
    };
  }

  return {
    file,
    podman,
    launch,
    probe,
    createStopGate: (mode: "timeout" | "stdin") =>
      createStopGate(options, configDir, mode),
    traceLauncher: () => traceLauncher(options, configDir),
  };
}

type Fixture = ReturnType<typeof createFixture>;
type GuestIdentity = { pid: string; startTime: string; marker: string };

async function liveGuest(
  fixture: Fixture,
  container: string,
  pid: string,
  id: string,
) {
  const observed = await fixture.probe(container, pid);
  expect(observed.startTime).toMatch(/^\d+$/);
  expect(observed.marker).toBe(id);
  return { pid, ...observed };
}

function wrapperResources(fixture: Fixture, container: string, id: string) {
  return fixture.podman(
    "exec",
    container,
    "/bin/sh",
    "-c",
    `if test -S "$1.sock"; then echo present; else echo absent; fi
if test -f "$1.state"; then echo present; else echo absent; fi`,
    "check-wrapper-resources",
    `/tmp/sandbox-e2e-${id}`,
  );
}

type Session = ReturnType<Fixture["launch"]>;
type LauncherTrace = Awaited<ReturnType<typeof traceLauncher>>;

async function finishEndHook(
  fixture: Fixture,
  session: Session,
  id: string,
  exitCode: number,
  shellRootTrace?: LauncherTrace,
  beforeRelease?: () => Promise<void>,
) {
  const start = () => readOptional(fixture.file(`start-${id}`));
  const end = () => readOptional(fixture.file(`end-${id}`));
  const hookStarted = async () => (await start()) || undefined;
  if (shellRootTrace) {
    await waitFor(
      hookStarted,
      15_000,
      "End hook did not start after closing the shell-root PTY",
    );
  } else {
    await session.observe(hookStarted, 15_000, "end hook did not start");
  }
  await beforeRelease?.();
  await Bun.sleep(100);
  if (shellRootTrace) {
    expect(
      await shellRootTrace.exited(),
      "Launcher must wait for the blocked end hook",
    ).toBe("");
  } else {
    expect(
      session.status,
      "CLI must wait for the blocked end hook",
    ).toBeUndefined();
  }
  expect(await end()).toBe("");
  await Bun.write(fixture.file(`finish-${id}`), "");
  if (shellRootTrace) {
    const launcherExit = await waitFor(
      async () => (await shellRootTrace.exited()) || undefined,
      12_000,
      "Launcher did not exit after closing the shell-root PTY",
    );
    expect(launcherExit).toBe(String(exitCode));
    const signals = (await shellRootTrace.received()).trim().split("\n");
    expect(signals).toContain("SIGHUP");
    console.log(
      `Closing the private PTY delivered ${signals.length} hangup(s)`,
    );
    await session.exited();
  } else {
    expect(await session.exited()).toBe(exitCode);
  }
  expect(await start()).toBe(`${id}\n`);
  expect(await end()).toBe(`${id}\n`);
}

async function assertSiblingReplies(
  fixture: Fixture,
  sibling: GuestIdentity,
  requestId: string,
) {
  const request = fixture.file("sibling.request.pending");
  await Bun.write(request, `${requestId}\n`);
  await rename(request, fixture.file("sibling.request"));
  expect(
    await waitFor(
      async () =>
        (await readOptional(fixture.file("sibling.reply"))) || undefined,
      5_000,
      "Sibling did not answer after the target shut down",
    ),
  ).toBe(`${sibling.pid} ${requestId}\n`);
}

async function verifyGuestCleanup(
  fixture: Fixture,
  container: string,
  target: GuestIdentity,
  sibling: GuestIdentity,
  worker: string,
  scenario: Scenario,
  targetGone: () => Promise<boolean>,
) {
  expect(
    await liveGuest(fixture, container, sibling.pid, sibling.marker),
  ).toEqual(sibling);
  if ("stopTimeout" in scenario) {
    await assertSiblingReplies(fixture, sibling, target.marker);
    const observed = await fixture.probe(container, target.pid);
    expect(
      {
        sameBirth: observed.startTime === target.startTime,
        marker: observed.marker,
      },
      `Target PID ${target.pid} (birth ${target.startTime}, observed ${observed.startTime}) and UUID ${target.marker} must be gone`,
    ).toEqual({ sameBirth: false, marker: "absent" });
  } else if ("repeated" in scenario || "shellRoot" in scenario) {
    await assertSiblingReplies(fixture, sibling, target.marker);
    expect(
      await fixture.probe(container, target.pid),
      "Target PID or session index survived attachment loss",
    ).toEqual({ startTime: "absent", marker: "absent" });
  } else {
    // The idle watcher can remove a stale marker after a normal exit.
    await waitFor(
      async () => (await targetGone()) || undefined,
      8_000,
      `${scenario.label}: target process or marker survived`,
    );
  }
  if ("shellRoot" in scenario && scenario.shellRoot === "wrapped") {
    expect(
      (await fixture.probe(container, worker)).startTime,
      "Wrapper worker survived",
    ).toBe("absent");
    expect(
      await wrapperResources(fixture, container, target.marker),
      "Wrapper socket or state survived",
    ).toBe("absent\nabsent");
  }
}

async function verifyWorkerStarted(
  fixture: Fixture,
  container: string,
  { pid, id, worker }: Awaited<ReturnType<Session["ready"]>>,
  wrapped: boolean,
) {
  if (!wrapped) {
    expect(worker).toBe(pid);
    return;
  }
  expect(worker).not.toBe(pid);
  expect((await fixture.probe(container, worker)).startTime).toMatch(/^\d+$/);
  expect(await wrapperResources(fixture, container, id)).toBe(
    "present\npresent",
  );
}

async function triggerShutdown(
  fixture: Fixture,
  container: string,
  target: GuestIdentity,
  scenario: Scenario,
  session: Session,
  gate?: Awaited<ReturnType<typeof createStopGate>>,
  trace?: LauncherTrace,
) {
  if (!("action" in scenario)) {
    await Bun.write(fixture.file(`${scenario.label}.release`), "");
    return;
  }
  const { pid, marker: id } = target;
  if (gate?.mode === "timeout") await gate.target(id);
  session.send(scenario.action);
  if (gate?.mode !== "stdin" || !trace) return;

  const stoppingId = await session.observe(
    async () => (await gate.ready()) || undefined,
    10_000,
    "Podman guest-stop exec did not reach its stdin gate",
  );
  expect(stoppingId).toBe(`${id}\n`);
  expect(await trace.received()).toBe("SIGHUP\n");
  expect(await liveGuest(fixture, container, pid, id)).toEqual(target);
  session.send("H");
  await session.observe(
    async () => (await trace.received()) === "SIGHUP\nSIGHUP\n" || undefined,
    2_000,
    "CLI did not dispatch a second hangup while the stop exec was blocked",
  );
  await gate.release();
}

async function verifyScenario(
  fixture: Fixture,
  container: string,
  sibling: GuestIdentity,
  scenario: Scenario,
) {
  const { label, exitCode } = scenario;
  const action = "action" in scenario ? scenario.action : undefined;
  const stopTimeout = "stopTimeout" in scenario;
  const gate = stopTimeout
    ? await fixture.createStopGate("timeout")
    : "repeated" in scenario
      ? await fixture.createStopGate("stdin")
      : undefined;
  const shellRoot = "shellRoot" in scenario ? scenario.shellRoot : undefined;
  const trace = gate || shellRoot ? await fixture.traceLauncher() : undefined;
  const session = fixture.launch(label, {
    verbose: !shellRoot && (action === "C" || gate !== undefined),
    redirect: "redirect" in scenario,
    env: { ...gate?.env, ...trace?.env },
    shellRoot: shellRoot !== undefined,
    skipWrapper: shellRoot === "unwrapped",
  });
  try {
    await using _session = session;
    const ready = await session.ready();
    const { pid, id, worker } = ready;
    const target = await liveGuest(fixture, container, pid, id);
    await verifyWorkerStarted(
      fixture,
      container,
      ready,
      shellRoot === "wrapped",
    );
    await triggerShutdown(
      fixture,
      container,
      target,
      scenario,
      session,
      gate,
      trace,
    );

    const targetGone = async () => {
      const observed = await fixture.probe(container, pid);
      return (
        observed.startTime !== target.startTime && observed.marker === "absent"
      );
    };
    await finishEndHook(
      fixture,
      session,
      id,
      exitCode,
      shellRoot ? trace : undefined,
      action && !gate && !shellRoot
        ? async () => {
            expect(
              await targetGone(),
              "Target survived into the end hook",
            ).toBe(true);
          }
        : undefined,
    );

    await verifyGuestCleanup(
      fixture,
      container,
      target,
      sibling,
      worker,
      scenario,
      targetGone,
    );
    if (gate?.mode === "timeout") {
      expect(await gate.attempts(), `Stop attempts for ${id}`).toBe(2);
      expect(
        await gate.expired(),
        "Host stop gate reached its safety limit",
      ).toBe(false);
      expect(await trace?.received()).toBe("SIGHUP\n");
    }
    console.log(
      `${label}: exit=${exitCode}, target gone, end hook once, sibling live`,
    );
  } catch (error) {
    throw new Error(
      `${label}: ${String(error)}\nPTY output:\n${await session.diagnostics()}`,
      { cause: error },
    );
  }
}

export async function verifyAttachedSessions(
  sb: SandboxInstance,
  projectSlug: string,
  scenario: AttachedSessionScenario,
) {
  const fixture = createFixture(sb.fixtureProcess, sb.configDir);
  const sibling = fixture.launch("sibling", {
    skipWrapper:
      scenario === "shell-root" || scenario === "shell-root-no-wrapper",
  });
  try {
    await using _sibling = sibling;
    const { pid, id } = await sibling.ready();
    const ids = await fixture.podman(
      "ps",
      "--filter",
      `label=sandbox.project=${projectSlug}`,
      "--no-trunc",
      "--format",
      "{{.ID}}",
    );
    expect(ids, "Expected one container for the disposable project").toMatch(
      /^[a-f0-9]+$/,
    );
    const identity = await liveGuest(fixture, ids, pid, id);
    const cases =
      scenario === "shell-root"
        ? [shellRootScenario]
        : scenario === "shell-root-no-wrapper"
          ? [unwrappedShellRootScenario]
          : scenario === "repeated-hangup"
            ? [repeatedHangupScenario]
            : scenario === "timed-out-stop"
              ? [timedOutStopScenario]
              : scenarios;
    for (const testCase of cases) {
      await verifyScenario(fixture, ids, identity, testCase);
      expect(sibling.status, "Sibling CLI exited early").toBeUndefined();
    }
    await fixture.podman(
      "exec",
      "--user",
      "sandbox",
      ids,
      "/bin/sh",
      "-c",
      'test -d "$1" && test ! -r "$1" && test ! -w "$1" && test ! -x "$1"',
      "check-registry",
      "/run/sandbox/session-shutdown",
    );
    await Bun.write(fixture.file(`finish-${id}`), "");
    await Bun.write(fixture.file("sibling.release"), "");
    expect(await sibling.exited()).toBe(0);
  } catch (error) {
    throw new Error(
      `Sibling: ${String(error)}\nPTY output:\n${await sibling.diagnostics()}`,
      { cause: error },
    );
  }
}
