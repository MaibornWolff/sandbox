import type { SandboxResult } from "./e2e-sandbox-helpers.js";

const runtimeTargets = new Set(["/run/.containerenv"]);
const readOnlyRuntimeTargets = new Set([
  "/opt/sandbox-cli",
  "/.cz-init",
  "/dev/init",
  "/run/.containerinit",
  "/run/podman-init",
  "/usr/sbin/docker-init",
]);
const systemFilesystems = new Set([
  "cgroup",
  "cgroup2",
  "devpts",
  "devtmpfs",
  "mqueue",
  "proc",
  "sysfs",
  "tmpfs",
]);

function isWithin(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}

function isSafeMount(line: string, projectDir: string): boolean {
  const match = /^.+ on (.+) type (\S+) \(([^)]+)\)$/.exec(line);
  if (!match) return false;
  const [, target = "", filesystem = "", options = ""] = match;
  if (readOnlyRuntimeTargets.has(target))
    return options.split(",").includes("ro");
  if (runtimeTargets.has(target)) return true;
  if (target === "/run/secrets") return filesystem === "tmpfs";
  if (target === "/")
    return ["overlay", "ext4", "fuse.fuse-overlayfs"].includes(filesystem);
  if (
    [
      projectDir,
      "/workspace",
      "/var/cache",
      "/home/sandbox",
      "/etc/sandbox",
    ].some((root) => isWithin(target, root))
  )
    return true;
  if (["/etc/hosts", "/etc/hostname", "/etc/resolv.conf"].includes(target))
    return true;
  return (
    systemFilesystems.has(filesystem) &&
    ["/dev", "/proc", "/sys"].some((root) => isWithin(target, root))
  );
}

export function assertSafeContainerMounts(
  result: Pick<SandboxResult, "exitCode" | "stdout">,
  projectDir: string,
): void {
  if (result.exitCode !== 0)
    throw new Error(
      `Mount inspection failed with exit code ${result.exitCode}`,
    );
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("No mount points were reported");
  const unexpected = lines.filter((line) => !isSafeMount(line, projectDir));
  if (unexpected.length > 0)
    throw new Error(`Unexpected mount points:\n${unexpected.join("\n")}`);
}
