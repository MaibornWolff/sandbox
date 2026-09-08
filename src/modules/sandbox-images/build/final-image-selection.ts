import {
  getGlobalDockerfilePath,
  getProjectDockerfilePath,
} from "#modules/configuration/index.js";
import {
  BASE_IMAGE,
  getProjectImageName,
  USER_IMAGE,
} from "#modules/sandbox-resources/index.js";
import { pathExists } from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import { generateProjectSlug } from "#shared/text/index.js";

export function getFinalImage(projectRoot: string): string {
  const logger = getLogger();
  const projectDockerfile = getProjectDockerfilePath(projectRoot);
  if (pathExists(projectDockerfile)) {
    const imageName = getProjectImageName(generateProjectSlug(projectRoot));
    logger.debug(`Using project layer: ${imageName}`);
    return imageName;
  }

  if (pathExists(getGlobalDockerfilePath())) {
    logger.debug(`Using user layer: ${USER_IMAGE}`);
    return USER_IMAGE;
  }

  logger.debug(`Using base layer: ${BASE_IMAGE}`);
  return BASE_IMAGE;
}
