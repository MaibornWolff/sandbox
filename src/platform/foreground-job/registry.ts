import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export interface JobProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly uid: number;
  readonly realUid: number;
  readonly birth: string;
  readonly pgid: number;
  readonly terminal: number | null;
  readonly foregroundPgid: number;
}

export interface RelativeJobFiles {
  open(
    directory: number,
    name: string,
    flags: number,
    mode: number,
  ): number | null;
  move(directory: number, from: string, to: string): void;
  remove(directory: number, name: string): void;
}

export interface HostJobProcesses {
  readonly uid: number;
  readonly pid: number;
  readonly boot: string;
  readonly directory: string;
  readonly files: RelativeJobFiles;
  read(pid: number): JobProcess | null;
}

const pid = z.number().int().min(1).max(2_147_483_647);
const birth = z.string().regex(/^[0-9]{1,20}:[0-9]{1,6}$/u);
const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const target = z.object({ endpoint: sha256, containerId: sha256 });
const binding = z.union([
  z.literal("starting"),
  z.literal("unavailable"),
  target,
]);
const savedJob = z.object({
  version: z.literal(2),
  boot: uuid,
  sessionId: uuid,
  pgid: pid,
  launcherPid: pid,
  launcherBirth: birth,
  leaderBirth: birth.nullable(),
  terminal: z.number().int().min(0).max(0xfffffffe),
  binding,
  attachmentProcess: z.object({ pid, birth }).nullable(),
});

type StoredJob = z.infer<typeof savedJob>;
type JobQuery = { pgid: number } | { sessionIds: ReadonlySet<string> };
export type ForegroundJobTarget = z.infer<typeof target>;
export interface VerifiedForegroundJob {
  readonly pgid: number;
  readonly sessionId: string;
  readonly binding: z.infer<typeof binding>;
  readonly snapshot: string;
}

export class ForegroundJobMountOverlapError extends Error {
  constructor() {
    super(
      "Foreground-job status is unavailable because a Podman machine shares the host registry location.",
    );
  }
}

export interface ForegroundJobPublication extends Disposable {
  avoidMounts(sources: readonly string[]): boolean;
  markUnavailable(): void;
  attach(target: ForegroundJobTarget, runtimePid: number): void;
}

const namePattern =
  /^([1-9][0-9]{0,9})-([1-9][0-9]{0,9})-([a-f0-9-]{36})\.json$/u;
const recordBytes = 1024;

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function fileName(record: StoredJob): string {
  return `${record.pgid}-${record.launcherPid}-${record.sessionId}.json`;
}

function includesPath(parent: string, child: string): boolean {
  const target = statSync(parent, { bigint: true });
  // A spelling comparison misses paths on case-insensitive host filesystems.
  for (let path = child; ; path = dirname(path)) {
    const entry = statSync(path, { bigint: true });
    if (entry.dev === target.dev && entry.ino === target.ino) return true;
    if (dirname(path) === path) return false;
  }
}

function verifyDirectory(fd: number, directory: string, uid: number): void {
  const opened = fstatSync(fd, { bigint: true });
  const current = lstatSync(directory, { bigint: true });
  if (
    !current.isDirectory() ||
    opened.uid !== BigInt(uid) ||
    (opened.mode & 0o777n) !== 0o700n ||
    current.dev !== opened.dev ||
    current.ino !== opened.ino
  ) {
    throw new Error("The foreground-job registry is not private.");
  }
}

function openDirectory(directory: string, uid: number): number {
  const fd = openSync(
    directory,
    constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_RDONLY,
  );
  try {
    verifyDirectory(fd, directory, uid);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readRecord(
  files: RelativeJobFiles,
  directory: number,
  name: string,
  uid: number,
): StoredJob | null {
  const fd = files.open(
    directory,
    name,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0,
  );
  if (fd === null) return null;
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== uid ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > recordBytes
    )
      throw new Error("Invalid foreground-job record file.");
    const buffer = Buffer.alloc(recordBytes + 1);
    const size = readSync(fd, buffer);
    if (size !== info.size)
      throw new Error("Could not read the foreground-job record.");
    return savedJob.parse(JSON.parse(buffer.toString("utf8", 0, size)));
  } finally {
    closeSync(fd);
  }
}

function owned(identity: JobProcess, uid: number): boolean {
  return identity.uid === uid && identity.realUid === uid;
}

function matches(name: string, query: JobQuery): boolean {
  const fields = namePattern.exec(name);
  if (!fields) return false;
  return "pgid" in query
    ? Number(fields[1]) === query.pgid
    : query.sessionIds.has(fields[3] ?? "");
}

function readLeader(
  host: HostJobProcesses,
  launcher: JobProcess,
): JobProcess | null {
  return launcher.pid === launcher.pgid ? launcher : host.read(launcher.pgid);
}

function liveRuntime(
  host: HostJobProcesses,
  record: StoredJob,
  processId: number,
): JobProcess | null {
  const client = host.read(processId);
  if (
    !client ||
    client.parentPid !== record.launcherPid ||
    client.pgid !== record.pgid ||
    client.terminal !== record.terminal ||
    !owned(client, host.uid)
  )
    return null;
  return client;
}

function activeJob(
  host: HostJobProcesses,
  record: StoredJob,
): VerifiedForegroundJob | null {
  if (record.boot !== host.boot) return null;
  const launcher = host.read(record.launcherPid);
  if (
    !launcher ||
    launcher.birth !== record.launcherBirth ||
    launcher.pgid !== record.pgid ||
    launcher.terminal !== record.terminal ||
    launcher.foregroundPgid !== record.pgid
  )
    return null;
  if (!owned(launcher, host.uid))
    throw new Error("Could not verify the host launcher owner.");
  const leader = readLeader(host, launcher);
  if (
    !leader ||
    !owned(leader, host.uid) ||
    leader.birth !== record.leaderBirth ||
    leader.pgid !== record.pgid ||
    leader.terminal !== record.terminal
  )
    throw new Error("Could not verify the foreground group leader.");
  if (leader.foregroundPgid !== record.pgid) return null;
  if (typeof record.binding === "object") {
    const expected = record.attachmentProcess;
    if (!expected) throw new Error("Missing foreground runtime process.");
    if (liveRuntime(host, record, expected.pid)?.birth !== expected.birth)
      return null;
  }
  const { sessionId, pgid, binding } = record;
  return {
    sessionId,
    pgid,
    binding,
    snapshot: createHash("sha256").update(JSON.stringify(record)).digest("hex"),
  };
}

export function createRegistry(host: HostJobProcesses) {
  const base = realpathSync(host.directory);
  closeSync(openDirectory(base, host.uid));
  const directory = join(base, "maibornwolff-sandbox-foreground-v2");
  const { files } = host;

  function assertIsolated(sources: readonly string[]): void {
    for (const source of sources) {
      const path = realpathSync(source);
      if (includesPath(path, base) || includesPath(base, path))
        throw new ForegroundJobMountOverlapError();
    }
  }

  function startPublication(record: StoredJob): ForegroundJobPublication {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    }
    const fd = openDirectory(directory, host.uid);
    const destination = fileName(record);
    function publish(
      binding: StoredJob["binding"],
      attachmentProcess: StoredJob["attachmentProcess"],
    ): void {
      verifyDirectory(fd, directory, host.uid);
      const temporary = `pending-${randomUUID()}`;
      const file = files.open(
        fd,
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      if (file === null)
        throw new Error("Could not create a foreground-job record.");
      try {
        writeFileSync(
          file,
          JSON.stringify(
            savedJob.parse({ ...record, binding, attachmentProcess }),
          ),
        );
        files.move(fd, temporary, destination);
      } finally {
        closeSync(file);
        files.remove(fd, temporary);
      }
    }
    let active = true;
    const dispose = () => {
      if (!active) return;
      active = false;
      try {
        files.remove(fd, destination);
      } finally {
        closeSync(fd);
      }
    };
    function markUnavailable(): void {
      if (!active) return;
      try {
        publish("unavailable", null);
      } catch (error) {
        dispose();
        throw error;
      }
    }
    try {
      publish("starting", null);
    } catch (error) {
      dispose();
      throw error;
    }
    return {
      avoidMounts(sources) {
        if (!active) return false;
        try {
          verifyDirectory(fd, directory, host.uid);
          assertIsolated(sources);
          return true;
        } catch {
          dispose();
          return false;
        }
      },
      markUnavailable,
      attach(target, runtimePid) {
        if (!active) return;
        try {
          const client = liveRuntime(host, record, runtimePid);
          if (!client)
            throw new Error("Could not verify the host attachment process.");
          publish(target, { pid: client.pid, birth: client.birth });
        } catch {
          markUnavailable();
        }
      },
      [Symbol.dispose]: dispose,
    };
  }

  return {
    assertIsolated,
    register(sessionId: string): ForegroundJobPublication | undefined {
      const launcher = host.read(host.pid);
      if (
        !launcher ||
        launcher.pgid <= 0 ||
        launcher.terminal === null ||
        !owned(launcher, host.uid)
      )
        return;
      let leader: JobProcess | null = null;
      try {
        leader = readLeader(host, launcher);
      } catch {
        // A lookup must fail closed if it cannot verify the original group instance.
      }
      return startPublication(
        savedJob.parse({
          version: 2,
          boot: host.boot,
          sessionId,
          pgid: launcher.pgid,
          launcherPid: launcher.pid,
          launcherBirth: launcher.birth,
          leaderBirth: leader?.birth ?? null,
          terminal: launcher.terminal,
          binding: "starting",
          attachmentProcess: null,
        }),
      );
    },
    find(query: JobQuery): readonly VerifiedForegroundJob[] {
      let fd: number;
      try {
        fd = openDirectory(directory, host.uid);
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
      try {
        // Node only lists by path. Read records relative to the verified directory descriptor.
        const names = readdirSync(directory);
        verifyDirectory(fd, directory, host.uid);
        return names
          .filter((name) => matches(name, query))
          .flatMap((name) => {
            const record = readRecord(files, fd, name, host.uid);
            if (!record) return [];
            if (fileName(record) !== name)
              throw new Error("Mismatched foreground-job record.");
            const candidate = activeJob(host, record);
            return candidate ? [candidate] : [];
          });
      } finally {
        closeSync(fd);
      }
    },
  };
}
