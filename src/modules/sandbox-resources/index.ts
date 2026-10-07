/** @lintignore Public sandbox resource naming API. */
export {
  BASE_IMAGE,
  CACHE_VOLUME,
  getNamedVolumeName,
  getProjectImageName,
  USER_IMAGE,
} from "./resource-naming.js";
export {
  ensureRuntimeStorage,
  removeRuntimeStorage,
} from "./runtime-storage.js";
