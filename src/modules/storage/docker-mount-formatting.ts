import { windowsPathToDocker } from "#shared/text/index.js";
import type { Mount } from "./mount.js";

/**
 * Convert a Mount to Docker -v argument format
 *
 * @param mount - Mount configuration object
 * @returns Docker volume argument string (e.g., "/host/path:/container/path:rw")
 *
 * @example
 * mountToDockerArg({
 *   hostPath: "/home/user/.config",
 *   containerPath: "/home/sandbox/.config",
 *   mode: "rw"
 * });
 * // Returns: "/home/user/.config:/home/sandbox/.config:rw"
 */
export function mountToDockerArg(mount: Mount): string {
  const dockerHostPath = windowsPathToDocker(mount.hostPath);
  return `${dockerHostPath}:${mount.containerPath}:${mount.mode}`;
}
