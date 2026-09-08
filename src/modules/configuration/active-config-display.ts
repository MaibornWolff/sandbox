import { getLogger } from "#platform/logging/index.js";
import type { Config } from "./config.js";

/**
 * Show active configuration before starting shell
 */
export function showActiveConfig(cfg: Config): void {
  const active: string[] = [];

  if (cfg.readonly) active.push("readonly");

  const extraMounts = cfg.mounts.length;
  const extraEnv = cfg.env.length;
  const extraPorts = cfg.ports.length;
  const allowedHostCommands = cfg.allowHostCommands.length;

  if (extraMounts > 0) active.push(`${extraMounts} mount(s)`);
  if (extraEnv > 0) active.push(`${extraEnv} env var(s)`);
  if (extraPorts > 0) active.push(`${extraPorts} port(s)`);
  if (allowedHostCommands > 0) {
    active.push(`${allowedHostCommands} allowed host command rule(s)`);
  }
  if (cfg.shmSize) active.push(`shm_size=${cfg.shmSize}`);

  if (active.length > 0) {
    getLogger().info(`Active: ${active.join(", ")}`);
  }
}
