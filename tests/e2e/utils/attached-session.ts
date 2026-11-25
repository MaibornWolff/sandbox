import { expect } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxInstance } from "./sandbox.js";

const bridge = fileURLToPath(
  new URL("../fixtures/attached-session-pty.py", import.meta.url),
);
type FixtureProcess = SandboxInstance["fixtureProcess"];

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

type Scenario = (typeof scenarios)[number];

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

  function launch(label: string, verbose = false, redirect = false) {
    const pty = startPty(
      [
        options.binary,
        ...(verbose ? ["-v"] : []),
        "--no-build",
        "run",
        "--",
        "/bin/sh",
        "./guest.sh",
        label,
        label === "normal" ? "42" : "0",
      ],
      options,
      redirect ? join(configDir, `${label}.stderr`) : undefined,
    );
    return Object.assign(pty, {
      async ready() {
        const text = await this.observe(
          async () => (await readOptional(file(`${label}.ready`))) || undefined,
          35_000,
          "guest did not become ready",
        );
        const [pid, id] = text.trim().split(" ");
        return {
          pid: unwrap(pid, "Missing guest PID"),
          id: unwrap(id, "Missing session ID"),
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
    const [startTime, marker, ...extra] = output.split("\n");
    expect(extra, `Invalid guest probe output: ${output}`).toEqual([]);
    return {
      startTime: unwrap(startTime, "Missing guest process observation"),
      marker: unwrap(marker, "Missing guest marker observation"),
    };
  }

  return { file, podman, launch, probe };
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

async function verifyScenario(
  fixture: Fixture,
  container: string,
  sibling: GuestIdentity,
  scenario: Scenario,
) {
  const { label, exitCode } = scenario;
  const action = "action" in scenario ? scenario.action : undefined;
  const session = fixture.launch(label, action === "C", "redirect" in scenario);
  try {
    await using _session = session;
    const { pid, id } = await session.ready();
    const target = await liveGuest(fixture, container, pid, id);
    const start = () => readOptional(fixture.file(`start-${id}`));
    const end = () => readOptional(fixture.file(`end-${id}`));
    if (action) session.send(action);
    else await Bun.write(fixture.file(`${label}.release`), "");

    await session.observe(
      async () => (await start()) || undefined,
      15_000,
      "end hook did not start",
    );
    const targetGone = async () => {
      const observed = await fixture.probe(container, pid);
      return (
        observed.startTime !== target.startTime && observed.marker === "absent"
      );
    };
    if (action)
      expect(await targetGone(), "Target survived into the end hook").toBe(
        true,
      );
    await Bun.sleep(100);
    expect(
      session.status,
      "CLI must wait for the blocked end hook",
    ).toBeUndefined();
    expect(await end()).toBe("");
    await Bun.write(fixture.file(`finish-${id}`), "");
    expect(await session.exited()).toBe(exitCode);
    expect(await start()).toBe(`${id}\n`);
    expect(await end()).toBe(`${id}\n`);

    // The idle watcher can remove a stale marker after a normal exit.
    await waitFor(
      async () => (await targetGone()) || undefined,
      8_000,
      `${label}: target process or marker survived`,
    );
    expect(
      await liveGuest(fixture, container, sibling.pid, sibling.marker),
    ).toEqual(sibling);
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
) {
  const fixture = createFixture(sb.fixtureProcess, sb.configDir);
  const sibling = fixture.launch("sibling");
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
    for (const scenario of scenarios) {
      await verifyScenario(fixture, ids, identity, scenario);
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
