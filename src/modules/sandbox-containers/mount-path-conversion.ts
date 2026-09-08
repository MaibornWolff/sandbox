import { isWindowsDrivePath, windowsPathToDocker } from "#shared/text/index.js";

export function convertMountForDocker(mount: string): string {
  if (!isWindowsDrivePath(mount)) {
    const parts = mount.split(":");
    if (parts.length >= 3 && parts[0] && parts[1]) {
      return `${windowsPathToDocker(parts[0])}:${parts[1]}:${parts.slice(2).join(":")}`;
    }
    return mount;
  }

  const colonSlashIndex = mount.indexOf(":/", 2);
  if (colonSlashIndex === -1) return mount;

  const hostPath = mount.slice(0, colonSlashIndex);
  const restParts = mount.slice(colonSlashIndex + 1).split(":");
  const targetPath = restParts[0];
  const mode = restParts.slice(1).join(":") || "ro";
  return `${windowsPathToDocker(hostPath)}:${targetPath}:${mode}`;
}
