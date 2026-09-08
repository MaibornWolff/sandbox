import chalk from "chalk";
import {
  type ConfigOverrides,
  getConfigurationService,
} from "#modules/configuration/index.js";
import { getRuntimeProvider } from "#platform/container-runtime/index.js";
import { getLogger } from "#platform/logging/index.js";
import { runFullMigration } from "./legacy-resource-migration.js";
import { LEGACY_PREFIX, SANDBOX_PREFIX } from "./resource-naming.js";

/**
 * Migrate sandbox resources from legacy "sandbox--" naming to "sandbox-" naming.
 */
export async function migrateCommand(options: ConfigOverrides): Promise<void> {
  const { configuredRuntime, projectRoot } =
    await getConfigurationService().load(options);
  const service = await getRuntimeProvider().resolve(configuredRuntime);
  const logger = getLogger();

  logger.info(
    `Migrating sandbox resources from ${chalk.cyan(LEGACY_PREFIX)} to ${chalk.cyan(SANDBOX_PREFIX)} naming...`,
  );

  const result = await runFullMigration(service, projectRoot);

  const anyChanges =
    result.imagesRetagged > 0 ||
    result.volumeMigrated ||
    result.containersRemoved > 0 ||
    result.dockerfilesMigrated > 0;

  if (result.imagesRetagged > 0) {
    logger.success(`Retagged ${result.imagesRetagged} image(s)`);
  }
  if (result.volumeMigrated) {
    logger.success("Migrated cache volume");
  }
  if (result.containersRemoved > 0) {
    logger.success(
      `Removed ${result.containersRemoved} legacy container(s) (will be recreated on next run)`,
    );
  }
  if (result.dockerfilesMigrated > 0) {
    logger.success(`Updated ${result.dockerfilesMigrated} Dockerfile(s)`);
  }

  if (!anyChanges) {
    logger.success("Nothing to migrate - all resources use the new naming");
  } else {
    logger.success("Migration complete!");
  }
}
