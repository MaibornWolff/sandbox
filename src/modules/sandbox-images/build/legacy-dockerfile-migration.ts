import chalk from "chalk";
import {
  getGlobalDockerfilePath,
  getProjectDockerfilePath,
} from "#modules/configuration/index.js";
import { replaceLegacyImageReferences } from "#modules/sandbox-resources/index.js";
import {
  pathExists,
  readTextFile,
  writeTextFile,
} from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";

function migrateDockerfile(dockerfilePath: string): void {
  const logger = getLogger();
  if (!pathExists(dockerfilePath)) return;

  const content = readTextFile(dockerfilePath);
  const migrated = replaceLegacyImageReferences(content);
  if (migrated === content) {
    logger.debug(`No legacy image references in ${dockerfilePath}`);
    return;
  }

  writeTextFile(dockerfilePath, migrated);
  logger.info(
    `Updated legacy image references in ${chalk.dim(dockerfilePath)}`,
  );
}

/**
 * Rewrite parent image references that older Sandbox versions generated, so
 * existing Dockerfiles keep building after the image naming change.
 */
export function migrateLegacyDockerfiles(projectRoot: string): void {
  migrateDockerfile(getGlobalDockerfilePath());
  migrateDockerfile(getProjectDockerfilePath(projectRoot));
}
