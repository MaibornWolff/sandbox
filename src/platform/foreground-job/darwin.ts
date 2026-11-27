import { isAbsolute } from "node:path";
import type {
  HostJobProcesses,
  JobProcess,
  RelativeJobFiles,
} from "./registry.js";

const PROC_PIDTBSDINFO = 3;
const BSD_INFO_SIZE = 136;
const ENOENT = 2;
const ESRCH = 3;
const NO_DEVICE = 0xffffffff;
const DARWIN_USER_TEMP_DIR = 65537;

type NativeLibrary = Awaited<typeof import("koffi")>;

function readProcess(
  koffi: NativeLibrary,
  system: ReturnType<NativeLibrary["load"]>,
) {
  const pidInfo = system.func(
    "int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size)",
  );
  return (pid: number): JobProcess | null => {
    const info = Buffer.alloc(BSD_INFO_SIZE);
    const size: number = pidInfo(pid, PROC_PIDTBSDINFO, 0, info, info.length);
    if (size <= 0 && koffi.errno() === ESRCH) return null;
    if (size !== info.length || info.readUInt32LE(12) !== pid) {
      throw new Error("Could not verify the host process identity.");
    }
    // proc_bsdinfo in <sys/proc_info.h> has the same layout on both Darwin 64-bit architectures.
    const seconds = info.readBigUInt64LE(120);
    const microseconds = info.readBigUInt64LE(128);
    if (seconds === 0n || microseconds >= 1_000_000n) {
      throw new Error("Invalid host process birth time.");
    }
    const terminal = info.readUInt32LE(108);
    return {
      pid,
      parentPid: info.readUInt32LE(16),
      uid: info.readUInt32LE(20),
      realUid: info.readUInt32LE(28),
      birth: `${seconds}:${microseconds}`,
      pgid: info.readUInt32LE(100),
      terminal: terminal === NO_DEVICE ? null : terminal,
      foregroundPgid: info.readUInt32LE(112),
    };
  };
}

function relativeFiles(
  koffi: NativeLibrary,
  system: ReturnType<NativeLibrary["load"]>,
): RelativeJobFiles {
  const openAt = system.func(
    "int openat(int fd, const char *path, int flags, ...)",
  );
  const renameAt = system.func(
    "int renameat(int src, const char *from, int dst, const char *to)",
  );
  const unlinkAt = system.func(
    "int unlinkat(int fd, const char *path, int flags)",
  );
  return {
    open(directory, name, flags, mode) {
      const fd: number = openAt(directory, name, flags, "int", mode);
      if (fd >= 0) return fd;
      if (koffi.errno() === ENOENT) return null;
      throw new Error("Could not open a private foreground-job record.");
    },
    move(directory, from, to) {
      if (renameAt(directory, from, directory, to) !== 0)
        throw new Error("Could not replace the foreground-job record.");
    },
    remove(directory, name) {
      if (unlinkAt(directory, name, 0) !== 0 && koffi.errno() !== ENOENT)
        throw new Error("Could not remove the foreground-job record.");
    },
  };
}

export async function readDarwinJobProcesses(): Promise<HostJobProcesses> {
  const uid = process.getuid?.();
  if (
    process.platform !== "darwin" ||
    uid === undefined ||
    uid !== process.geteuid?.()
  ) {
    throw new Error("Foreground-job status is not supported on this host.");
  }
  const koffi = await import("koffi");
  const system = koffi.load("/usr/lib/libSystem.B.dylib");
  const libproc = koffi.load("/usr/lib/libproc.dylib");
  const confstr = system.func(
    "size_t confstr(int name, void *buffer, size_t length)",
  );
  const sysctl = system.func(
    "int sysctlbyname(const char *name, void *oldp, void *oldlenp, void *newp, size_t newlen)",
  );
  const directoryBuffer = Buffer.alloc(4096);
  const directoryLength = Number(
    confstr(DARWIN_USER_TEMP_DIR, directoryBuffer, directoryBuffer.length),
  );
  if (directoryLength <= 1 || directoryLength > directoryBuffer.length) {
    throw new Error("Could not find the private host runtime directory.");
  }
  const directory = directoryBuffer.toString("utf8", 0, directoryLength - 1);
  const bootBuffer = Buffer.alloc(64);
  const bootLength = Buffer.alloc(8);
  bootLength.writeBigUInt64LE(BigInt(bootBuffer.length));
  if (
    !isAbsolute(directory) ||
    sysctl("kern.bootsessionuuid", bootBuffer, bootLength, null, 0) !== 0
  ) {
    throw new Error("Could not verify the host boot identity.");
  }
  const boot = bootBuffer
    .toString("ascii", 0, Number(bootLength.readBigUInt64LE()) - 1)
    .toLowerCase();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(boot)) {
    throw new Error("Invalid host boot identity.");
  }
  return {
    uid,
    pid: process.pid,
    boot,
    directory,
    read: readProcess(koffi, libproc),
    files: relativeFiles(koffi, system),
  };
}
