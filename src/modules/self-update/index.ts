/** @lintignore Public self-update command and host update-check API. */

export { getVersion } from "./package-version.js";
export {
  runUpdateCheckWorker,
  UPDATE_CHECK_WORKER_ARGUMENT,
  warnIfUpdateAvailable,
} from "./update-availability.js";
export { updateCommand } from "./update-command.js";
