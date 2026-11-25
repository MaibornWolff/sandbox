import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import {
  assertSandboxSuccess,
  createSandbox,
  type SandboxInstance,
} from "./utils/sandbox.js";

let projectDir: string;
let sb: SandboxInstance;

const observationScript = `
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(fileURLToPath(import.meta.url));
const event = process.env.SANDBOX_EVENT;
const mode = process.argv[2];
if (mode === 'detached') {
  console.log('private-hook-stdout');
  console.error('private-hook-stderr');
  const stdin = readFileSync(0, 'utf8');
  if (stdin !== '' || process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY) {
    throw new Error('Expected an empty, noninteractive input stream and no terminal');
  }
  const deadline = performance.now() + 30_000;
  while (!existsSync(join(root, 'release-detached'))) {
    if (performance.now() >= deadline) process.exit(2);
    await delay(50);
  }
}
const marker = join(root, event + '.txt');
const temp = marker + '.' + process.pid;
writeFileSync(temp, [
  process.getuid(), basename(process.cwd()), process.env.SANDBOX_SESSION_ID ?? '',
].join('|'));
renameSync(temp, marker);
if (mode === 'detached') await delay(60_000);
`;

const timeoutScript = `
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const mode = process.argv[2];
if (mode === 'child' || mode === 'parent') {
  process.on('SIGTERM', () => {});
  if (mode === 'parent') {
    const child = spawn(process.execPath, [process.argv[1], 'child'], { stdio: 'ignore' });
    writeFileSync('parent.pid', String(process.pid));
    child.on('error', (error) => { throw error; });
  } else {
    writeFileSync('child.pid', String(process.pid));
  }
  await delay(60_000);
} else {
  function readPid(role) {
    try {
      const pid = readFileSync(role + '.pid', 'utf8');
      return /^[1-9][0-9]*$/.test(pid) ? pid : undefined;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  function isLive(pid) {
    try {
      const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
      throw error;
    }
  }
  const blocking = mode === 'verify-blocking';
  const leader = readPid('parent');
  if (blocking && (!leader || isLive(leader))) {
    throw new Error('Blocking hook returned before its leader stopped');
  }
  const deadline = performance.now() + (blocking ? 1_000 : 8_000);
  for (;;) {
    const parent = readPid('parent');
    const child = readPid('child');
    if (parent && child && !isLive(parent) && !isLive(child)) break;
    if (performance.now() >= deadline) {
      throw new Error('Expected both recorded hook processes to be stopped');
    }
    await delay(50);
  }
  console.log('hook-group-stopped');
}
`;

beforeAll(async () => {
  projectDir = await createTempProject("lifecycle-hooks");
  await writeProjectFile(
    projectDir,
    ".sandbox/docker/Dockerfile",
    "FROM sandbox-base:latest\nENV SANDBOX_IDLE_TIMEOUT_SECONDS=10\n",
  );
  await writeProjectFile(projectDir, "observe.mjs", observationScript);
  await writeProjectFile(projectDir, "timeout.mjs", timeoutScript);
  await writeProjectFile(projectDir, "subdir/.keep", "");
  sb = createSandbox({ cwd: join(projectDir, "subdir"), timeoutSeconds: 90 });
  assertSandboxSuccess(await sb.build());
}, 360_000);

async function readMarker(name: string): Promise<string> {
  return readFile(join(projectDir, name), "utf8");
}

async function waitForMarker(name: string): Promise<string> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    try {
      return await readMarker(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Hook did not write ${name}`);
}

async function waitForIdleStop(): Promise<void> {
  const deadline = performance.now() + 35_000;
  while (performance.now() < deadline) {
    const result = await sb.exec(["status"], { timeoutSeconds: 5 });
    assertSandboxSuccess(result);
    if (result.stdout.includes("No active containers")) return;
    await Bun.sleep(250);
  }
  throw new Error("Container did not stop after the last session exited");
}

afterAll(async () => {
  await cleanupProject(projectDir, sb);
}, 45_000);

test("a noninteractive hook survives launcher return without keeping the container alive", async () => {
  await writeProjectFile(
    projectDir,
    ".sandbox/config.toml",
    `[[hooks]]
event = "container.start"
command = ["node", "observe.mjs"]
wait = true

[[hooks]]
event = "session.start"
command = ["node", "../observe.mjs", "detached"]

[[hooks]]
event = "session.end"
command = ["node", "../observe.mjs"]
wait = true

[[hooks]]
event = "container.stop"
command = ["node", "observe.mjs"]
wait = true
`,
  );
  const result = await sb.exec(
    [
      "--no-build",
      "run",
      "--",
      "sh",
      "-c",
      'test -s ../container.start.txt && printf "%s|%s|%s\\n" "$(id -u)" "$(basename "$PWD")" "$SANDBOX_SESSION_ID"',
    ],
    { timeoutSeconds: 25 },
  );
  assertSandboxSuccess(result);
  expect(result.rawStdout + result.rawStderr).not.toContain("private-hook-");
  const session = await readMarker("session.end.txt");
  const [uid, cwd, id] = session.split("|");
  expect(uid).toMatch(/^[1-9]\d*$/);
  expect(cwd).toBe("subdir");
  expect(id).toMatch(/^[\da-f-]{36}$/i);
  expect(result.stdout.trim().split("\n")).toContain(session);
  expect(await readMarker("container.start.txt")).toBe(
    `${uid}|${basename(projectDir)}|`,
  );

  await expect(readMarker("session.start.txt")).rejects.toMatchObject({
    code: "ENOENT",
  });
  await writeProjectFile(projectDir, "release-detached", "release\n");
  expect(await waitForMarker("session.start.txt")).toBe(session);
  await waitForIdleStop();
  expect(await readMarker("container.stop.txt")).toBe(
    `${uid}|${basename(projectDir)}|`,
  );
}, 75_000);

test.each([true, false])(
  "a hook deadline kills the TERM-resistant hook and its child (wait=%s)",
  async (wait) => {
    await writeProjectFile(projectDir, "subdir/parent.pid", "");
    await writeProjectFile(projectDir, "subdir/child.pid", "");
    await writeProjectFile(
      projectDir,
      ".sandbox/config.toml",
      `[[hooks]]
event = "session.start"
command = ["node", "../timeout.mjs", "parent"]
wait = ${wait}
timeout = "2s"
on_error = "warn"
`,
    );
    const result = await sb.exec([
      "--no-build",
      "run",
      "--",
      "node",
      "../timeout.mjs",
      wait ? "verify-blocking" : "verify-background",
    ]);
    assertSandboxSuccess(result);
    expect(result.stdout).toContain("hook-group-stopped");
    assertSandboxSuccess(await sb.stop());
  },
  120_000,
);

test("explicit stop dispatches the graceful container stop hook", async () => {
  await writeProjectFile(
    projectDir,
    ".sandbox/config.toml",
    `[[hooks]]
event = "container.stop"
command = ["sh", "-c", "touch explicit-stop.txt"]
wait = true
`,
  );
  const command = sb.start([
    "--no-build",
    "run",
    "--",
    "sh",
    "-c",
    "echo attached-session-ready\nexec sleep 60",
  ]);
  await using stop = new AsyncDisposableStack();
  stop.defer(async () => {
    const result = await sb.stop();
    const attached = await command.result;
    assertSandboxSuccess(result);
    expect(attached.exitCode).toBe(143);
  });
  await command.waitForOutput("attached-session-ready", 30);
  await stop.disposeAsync();
  expect(await readMarker("explicit-stop.txt")).toBe("");
}, 125_000);
