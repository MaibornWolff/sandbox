import * as fs from "node:fs";
import path from "node:path";
import { getSandboxEnvironment } from "#platform/environment/index.js";
import { getProcessManager } from "#platform/process/index.js";
import { getTerminal } from "#platform/terminal/index.js";
import { executeContainerCommand } from "./command.js";

/** @testonly */
export const CONTAINER_READY_FILE = "/tmp/.sandbox-ready";
/** @testonly */
export const CONTAINER_SESSIONS_DIRECTORY = "/tmp/sandbox-sessions";
const CONTAINER_MOUNTS_FILE = "/proc/mounts";
const SETTINGS_DIRECTORY = "/etc/sandbox/settings";

function containerPath(absolutePath: string): string {
  return path.join(
    getSandboxEnvironment().filesystemRoot,
    absolutePath.replace(/^\/+/, ""),
  );
}

export function prepareContainerState(): void {
  fs.rmSync(containerPath(CONTAINER_READY_FILE), { force: true });
  fs.rmSync(containerPath(CONTAINER_SESSIONS_DIRECTORY), {
    recursive: true,
    force: true,
  });
  fs.mkdirSync(containerPath(CONTAINER_SESSIONS_DIRECTORY), {
    recursive: true,
  });
}

function decodeMountPath(value: string): string {
  return value.replace(/\\040/g, " ").replace(/\\011/g, "\t");
}

/** @testonly */
export function getMountOwnershipTargets(
  mounts: string,
  ownedRoots: readonly string[],
): readonly string[] {
  const targets = new Set<string>();
  for (const line of mounts.split(/\r?\n/)) {
    const mountPoint = line.trim().split(/\s+/)[1];
    if (!mountPoint) continue;
    let current = decodeMountPath(mountPoint);
    const ownedRoot = ownedRoots.find(
      (root) => current === root || current.startsWith(`${root}/`),
    );
    if (!ownedRoot) continue;
    targets.add(current);
    current = path.posix.dirname(current);
    while (current !== ownedRoot && current.startsWith(`${ownedRoot}/`)) {
      targets.add(current);
      current = path.posix.dirname(current);
    }
    targets.add(ownedRoot);
  }
  return [...targets];
}

export function repairMountOwnership(): readonly string[] {
  const environment = getSandboxEnvironment();
  const owner = fs.statSync(environment.homeDirectory);
  const targets = getMountOwnershipTargets(
    fs.readFileSync(containerPath(CONTAINER_MOUNTS_FILE), "utf8"),
    [environment.homeDirectory, containerPath(SETTINGS_DIRECTORY)],
  );
  for (const target of targets) {
    try {
      const current = fs.lstatSync(target);
      if (current.uid !== owner.uid || current.gid !== owner.gid) {
        fs.lchownSync(target, owner.uid, owner.gid);
      }
    } catch {
      // Some runtime-managed mounts cannot be re-owned.
    }
  }
  return targets;
}

export function writeSshProxyConfiguration(): void {
  const configurationDirectory = containerPath("/etc/ssh/ssh_config.d");
  fs.mkdirSync(configurationDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(configurationDirectory, "50-sandbox-proxy.conf"),
    renderSshProxyConfiguration(),
  );
}

/** @testonly */
export function renderSshProxyConfiguration(): string {
  return `Host 127.* localhost 10.* 172.16.* 172.17.* 172.18.* 172.19.* 172.2?.* 172.3?.* 192.168.*
    ProxyCommand none

Host *
    ProxyCommand socat - PROXY:127.0.0.1:%h:%p,proxyport=8888
`;
}

export function parseIdeBridgePort(
  value: string | undefined,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value))
    throw new Error(`Invalid IDE bridge port: ${value}`);
  const port = Number(value);
  if (port < 10_000 || port > 65_535) {
    throw new Error(`Invalid IDE bridge port: ${value}`);
  }
  return port;
}

/** @lintignore Public semantic IDE bridge lifecycle. */
export interface IdeBridgeLifecycle {
  readonly failure: Promise<Error>;
}

export function startIdeBridge(
  port: number,
  hostAccessName: string,
): IdeBridgeLifecycle {
  const child = getProcessManager().start({
    name: "ide-bridge",
    command: "/usr/bin/socat",
    args: [
      `TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr`,
      `TCP:${hostAccessName}:${port}`,
    ],
    lifetime: "application",
    interaction: { mode: "non-interactive" },
    stdio: "ignore",
  });
  const failure = child.result.then(
    (result) =>
      new Error(
        result.signal
          ? `ide-bridge exited with signal ${result.signal}`
          : `ide-bridge exited with code ${result.exitCode}`,
      ),
    (error: unknown) => new Error("ide-bridge failed", { cause: error }),
  );
  return { failure };
}

export function markContainerReady(): void {
  fs.closeSync(fs.openSync(containerPath(CONTAINER_READY_FILE), "a"));
}

/** @lintignore Public container session activity model. */
export interface SessionActivity {
  readonly markerSeen: boolean;
  readonly active: boolean;
}

interface SessionProcesses {
  readonly markerSeen: boolean;
  readonly activePids: readonly number[];
}

function sessionProcessState(pid: number): "active" | "missing" | "zombie" {
  try {
    const stat = fs.readFileSync(containerPath(`/proc/${pid}/stat`), "utf8");
    const processState = stat.slice(stat.lastIndexOf(")") + 1).trimStart()[0];
    return processState === "Z" ? "zombie" : "active";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

function inspectSessionProcesses(): SessionProcesses {
  const sessionsDirectory = containerPath(CONTAINER_SESSIONS_DIRECTORY);
  let markerSeen = false;
  const activePids: number[] = [];
  for (const marker of fs.readdirSync(sessionsDirectory)) {
    const markerPath = path.join(sessionsDirectory, marker);
    try {
      if (!fs.statSync(markerPath).isFile()) continue;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    markerSeen = true;
    const pid = Number(marker);
    if (Number.isInteger(pid) && sessionProcessState(pid) === "active") {
      activePids.push(pid);
    } else {
      fs.rmSync(markerPath, { force: true });
    }
  }
  return { markerSeen, activePids };
}

export function inspectSessionActivity(): SessionActivity {
  const sessions = inspectSessionProcesses();
  return {
    markerSeen: sessions.markerSeen,
    active: sessions.activePids.length > 0,
  };
}

export async function terminateContainerSessions(
  signal: NodeJS.Signals,
): Promise<void> {
  const manager = getProcessManager();
  const sessions: Array<{
    readonly pid: number;
    readonly captured: NonNullable<ReturnType<typeof manager.capture>>;
  }> = [];
  const failures: Error[] = [];
  for (const pid of inspectSessionProcesses().activePids) {
    try {
      const captured = manager.capture({ name: `session ${pid}`, pid });
      if (captured) sessions.push({ pid, captured });
      else {
        fs.rmSync(
          path.join(containerPath(CONTAINER_SESSIONS_DIRECTORY), String(pid)),
          { force: true },
        );
      }
    } catch (error) {
      failures.push(
        new Error(`Failed to capture session ${pid} safely.`, { cause: error }),
      );
    }
  }
  const outcomes = await Promise.allSettled(
    sessions.map(({ captured }) => captured.stop({ signal })),
  );
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "fulfilled") continue;
    const session = sessions[index];
    failures.push(
      new Error(`Failed to terminate session ${session?.pid ?? "unknown"}.`, {
        cause: outcome.reason,
      }),
    );
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "Failed to terminate container sessions.",
    );
  }
}

async function runSettingsCommandAsSandbox(
  command: "apply" | "sync",
): Promise<void> {
  const output = await executeContainerCommand("/usr/sbin/gosu", [
    "sandbox",
    "/usr/local/bin/sandbox-container-tools",
    "settings",
    command,
  ]);
  if (output.trim()) getTerminal().stdout.write(`${output.trimEnd()}\n`);
}

export async function runSettingsApplyAsSandbox(): Promise<void> {
  await runSettingsCommandAsSandbox("apply");
}

export async function runSettingsSyncAsSandbox(): Promise<void> {
  await runSettingsCommandAsSandbox("sync");
}
