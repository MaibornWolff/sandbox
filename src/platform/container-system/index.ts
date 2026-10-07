/** @lintignore Public container lifecycle contract. */
export {
  getSessionControlMarkerDirectory,
  type IdeBridgeLifecycle,
  inspectSessionActivity,
  markContainerReady,
  parseIdeBridgePort,
  prepareContainerState,
  repairMountOwnership,
  runSettingsApplyAsSandbox,
  runSettingsSyncAsSandbox,
  startIdeBridge,
  terminateContainerSessions,
  writeSshProxyConfiguration,
} from "./container-lifecycle.js";
/** @lintignore Public container-system path contract. */
export { CONTAINER_READY_FILE } from "./container-paths.js";
/** @lintignore Public container-system diagnostic contract. */
export {
  type ContainerLogSource,
  collectPassiveNetworkState,
  readContainerLog,
} from "./diagnostics.js";
/** @lintignore Public container-system DNS contract. */
export { isIpAddress, reverseDns } from "./dns.js";
/** @lintignore Public container-system network bootstrap contract. */
export {
  type ContainerNetworkSystem,
  createContainerNetworkSystem,
  getSquidDomainAclPath,
  type SquidDomainAclGroup,
} from "./network-bootstrap.js";
/** @lintignore Public container-system session contract. */
export {
  buildSessionDetailsCommand,
  buildSessionIdleCommand,
} from "./session-scripts.js";
/** @lintignore Public container-system TCP boundary contract. */
export {
  createNodeTcpService,
  getTcpService,
  provideTcpService,
  type TcpEndpoint,
  type TcpService,
} from "./tcp-service.js";
