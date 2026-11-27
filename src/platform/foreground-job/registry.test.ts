import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  createRegistry,
  type JobProcess,
  type RelativeJobFiles,
} from "./registry.js";

const uid = process.getuid?.() ?? 0;

function fixture() {
  const root = createTestDir("foreground-registry");
  const directory = join(root, "private");
  mkdirSync(directory, { mode: 0o700 });
  const boot = randomUUID();
  const unreadable = new Set<number>();
  const processes = new Map<number, JobProcess>();
  function processInGroup(pid: number, changes: Partial<JobProcess> = {}) {
    processes.set(pid, {
      pid,
      parentPid: 77,
      uid,
      realUid: uid,
      birth: `${pid}:1`,
      pgid: 77,
      terminal: 312,
      foregroundPgid: 77,
      ...changes,
    });
  }
  for (const pid of [77, 81, 82]) processInGroup(pid);
  const read = (pid: number) => {
    if (unreadable.has(pid)) throw new Error("identity unreadable");
    return processes.get(pid) ?? null;
  };
  const recordPath = (name: string) =>
    join(directory, readdirSync(directory)[0] ?? "missing", name);
  const files: RelativeJobFiles = {
    open(_directory, name, flags, mode) {
      try {
        return openSync(recordPath(name), flags, mode);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      }
    },
    move: (_directory, from, to) =>
      renameSync(recordPath(from), recordPath(to)),
    remove: (_directory, name) => rmSync(recordPath(name), { force: true }),
  };
  const open = (pid: number, bootId = boot) =>
    createRegistry({ directory, boot: bootId, uid, pid, read, files });
  const launcher = open(81);
  return {
    root,
    directory,
    processes,
    unreadable,
    processInGroup,
    open,
    launcher,
    find: () => launcher.find({ pgid: 77 }),
    [Symbol.dispose]: () => cleanupTestDir(root),
  };
}

test("publishes a wrapper-led job before binding the exact container", () => {
  using env = fixture();
  const sessionId = randomUUID();
  using job = env.launcher.register(sessionId);
  expect(env.find()).toMatchObject([
    { pgid: 77, sessionId, binding: "starting" },
  ]);
  const binding = { endpoint: "a".repeat(64), containerId: "b".repeat(64) };
  env.processInGroup(99, { parentPid: 81 });
  job?.attach(binding, 99);
  expect(env.launcher.find({ sessionIds: new Set([sessionId]) })).toMatchObject(
    [{ sessionId, binding }],
  );
  expect(env.find()).toHaveLength(1);
});

test("ignores a published attachment after the runtime client exits or its PID is reused", () => {
  using env = fixture();
  using job = env.launcher.register(randomUUID());
  env.processInGroup(99, { parentPid: 81 });
  job?.attach({ endpoint: "a".repeat(64), containerId: "b".repeat(64) }, 99);
  expect(env.find()).toHaveLength(1);
  env.processes.delete(99);
  expect(env.find()).toEqual([]);
  env.processInGroup(99, { parentPid: 81, birth: "99:2" });
  expect(env.find()).toEqual([]);
});

test("an unsafe Podman machine share prevents publication before the registry exists", () => {
  using env = fixture();
  expect(() => env.launcher.assertIsolated([env.root])).toThrow(
    "shares the host registry location",
  );
  expect(readdirSync(env.directory)).toEqual([]);
});

test("removes only the current publication when two launchers share a job", () => {
  using env = fixture();
  const first = randomUUID();
  const second = randomUUID();
  using sibling = env.open(82).register(second);
  {
    using _job = env.launcher.register(first);
    expect(env.find()).toHaveLength(2);
  }
  expect(env.find()).toMatchObject([{ sessionId: second }]);
  expect(sibling).toBeDefined();
});

test("ignores a stale launcher, a recycled PID, and a record from another boot", () => {
  using env = fixture();
  using _job = env.launcher.register(randomUUID());
  expect(env.open(81, randomUUID()).find({ pgid: 77 })).toEqual([]);
  env.processes.delete(81);
  expect(env.find()).toEqual([]);
  env.processInGroup(81, { birth: "81:2" });
  expect(env.find()).toEqual([]);
});

test("does not report a background group or one with a changed terminal", () => {
  using env = fixture();
  using _job = env.launcher.register(randomUUID());
  env.processInGroup(81, { foregroundPgid: 54 });
  expect(env.find()).toEqual([]);
  env.processInGroup(81, { terminal: 999 });
  expect(env.find()).toEqual([]);
});

test("fails closed for a missing leader, wrong user, or unreadable metadata", () => {
  using env = fixture();
  using _job = env.launcher.register(randomUUID());
  env.processes.delete(77);
  expect(env.find).toThrow("leader");
  env.processInGroup(77);
  env.processInGroup(81, { realUid: uid + 1 });
  expect(env.find).toThrow("owner");
  env.processInGroup(81);
  env.unreadable.add(81);
  expect(env.find).toThrow("unreadable");
});

test("rejects unprivate files instead of treating them as missing", () => {
  using env = fixture();
  const id = randomUUID();
  using _job = env.launcher.register(id);
  const [directory] = readdirSync(env.directory);
  const record = join(env.directory, directory ?? "", `77-81-${id}.json`);
  chmodSync(record, 0o644);
  expect(env.find).toThrow("Invalid foreground-job record file");
});

test("retires a publication if a mount would expose its directory through an ancestor symlink", () => {
  using env = fixture();
  const link = join(env.root, "link");
  symlinkSync(env.directory, link);
  using job = env.launcher.register(randomUUID());
  expect(job?.avoidMounts([link])).toBe(false);
  job?.markUnavailable();
  expect(env.find()).toEqual([]);
});
