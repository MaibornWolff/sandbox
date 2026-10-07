import chalk from "chalk";
import {
  getGlobalConfigPath,
  loadTomlConfig,
  validateConfig,
} from "#modules/configuration/index.js";
import {
  type BuildImagesResult,
  buildImages,
  getFinalImage,
} from "#modules/sandbox-images/index.js";
import type { SandboxRuntimeSelection } from "#platform/container-runtime/index.js";
import { getLogger } from "#platform/logging/index.js";
import { readState } from "#platform/state/index.js";
import { getTerminal } from "#platform/terminal/index.js";
import type { SandboxContext } from "../sandbox-context.js";
import type { SandboxOptions } from "../sandbox-options.js";

function writeErrorLine(message: string): void {
  getTerminal().stderr.write(`${message}\n`);
}

function displayConfigWarnings(silent: boolean): void {
  if (silent) return;
  const tomlConfig = loadTomlConfig(getGlobalConfigPath());
  if (!tomlConfig) return;

  const validation = validateConfig(tomlConfig);
  if (validation.warnings.length === 0) return;

  writeErrorLine(chalk.yellow("⚠️  Configuration warnings:"));
  for (const warning of validation.warnings) {
    writeErrorLine(chalk.yellow(`   ${warning}`));
  }
  if (validation.suggestRegenerate) {
    writeErrorLine(
      chalk.dim(
        '   Run "sandbox init" and select "config.toml" to regenerate with updated defaults.\n',
      ),
    );
  }
}

async function resolveExistingFinalImage(
  services: SandboxRuntimeSelection,
  projectRoot: string,
): Promise<BuildImagesResult> {
  const imageName = getFinalImage(projectRoot);
  const stateKey = `${services.imageOwnershipKey}:${imageName}`;
  const image = readState().sandboxImages?.[stateKey];
  if (!image || !/^sha256:[a-f0-9]+$/u.test(image.digest)) {
    throw new Error(
      `No complete image record exists for ${imageName}. Run sandbox build first or retry without --no-build.`,
    );
  }
  return { imageName, image };
}

export async function prepareSandboxEnvironment(
  services: SandboxRuntimeSelection,
  ctx: SandboxContext,
  cliOptions: SandboxOptions,
  useVerboseTiming: boolean,
  silent: boolean,
): Promise<BuildImagesResult> {
  const logger = getLogger();
  displayConfigWarnings(silent);
  logger.debug("Checking runtime host availability");
  await services.runtime.ensureHostReady();

  const skipBuild = cliOptions.noBuild || cliOptions.build === false;
  const label = skipBuild ? "Image resolution" : "Image checks and builds";
  if (useVerboseTiming) logger.startTiming(label);
  const buildResult = skipBuild
    ? await resolveExistingFinalImage(services, ctx.projectRoot)
    : await buildImages(services, { projectRoot: ctx.projectRoot }, silent);
  if (useVerboseTiming) logger.endTiming(label);
  return buildResult;
}
