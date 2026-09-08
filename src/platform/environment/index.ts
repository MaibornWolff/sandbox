export { parseEnvList } from "./env.js";
/** @lintignore Public host environment contract and test factory. */
export {
  createHostEnvironment,
  getHostEnvironment,
  type HostEnvironment,
  provideHostEnvironment,
  readProcessEnvironment,
} from "./host-environment.js";
/** @lintignore Public sandbox environment contract and production factory. */
export {
  createSandboxEnvironment,
  getSandboxEnvironment,
  provideSandboxEnvironment,
  readSandboxProcessEnvironment,
  type SandboxEnvironment,
} from "./sandbox-environment.js";
export { exitProcess, getProcessArguments, setExitCode } from "./system.js";
export {
  checkXHostAccess,
  detectX11,
  isWindowsXServerInstalled,
  isXQuartzInstalled,
  isXQuartzNetworkAccessEnabled,
  isXQuartzRestartNeeded,
} from "./x11.js";
export type { X11Config } from "./x11-config.js";
