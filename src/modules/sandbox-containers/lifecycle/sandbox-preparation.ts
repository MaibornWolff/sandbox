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
import type { ContainerRuntime } from "#platform/container-runtime/index.js";
import { detectX11 } from "#platform/environment/index.js";
import { getLogger } from "#platform/logging/index.js";
import { getTerminal } from "#platform/terminal/index.js";
import { getImageId } from "../container-hashing.js";
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

export async function getImageIdFallback(
  service: ContainerRuntime,
  imageName: string,
): Promise<string> {
  try {
    return await getImageId(service, imageName);
  } catch {
    return "";
  }
}

async function resolveExistingFinalImage(
  service: ContainerRuntime,
  projectRoot: string,
): Promise<BuildImagesResult> {
  const imageName = getFinalImage(projectRoot);
  const inspection = await service.inspectImage(imageName);
  if (!inspection) {
    throw new Error(
      `Image ${imageName} is not available. Run sandbox build first or retry without --no-build.`,
    );
  }
  return { imageName, imageId: inspection.id };
}

function checkRuntimeMemory(memBytes: number | null): void {
  const logger = getLogger();
  if (memBytes === null) return;
  const memGB = memBytes / (1024 * 1024 * 1024);
  logger.debug(`Runtime memory: ${memGB.toFixed(1)}GB`);
  if (memGB < 3.5) {
    logger.warn(
      `Runtime has ${memGB.toFixed(1)}GB memory. Claude Code needs 4GB+.`,
    );
    logger.info(`Increase memory: ${chalk.cyan("colima start --memory 4")}`);
  }
}

export async function warnIfX11Unavailable(
  silent: boolean,
  clipboard: string,
): Promise<void> {
  if (silent || clipboard === "disabled") return;
  if ((await detectX11()).available) return;

  writeErrorLine(chalk.yellow("⚠️  X11 clipboard not available"));
  writeErrorLine(
    chalk.yellow("   Run `sandbox setup-x11` for setup instructions"),
  );
  writeErrorLine(
    chalk.yellow(
      "   Terminal text clipboard may work via OSC 52 passthrough\n",
    ),
  );
}

export async function prepareSandboxEnvironment(
  runtimeService: ContainerRuntime,
  ctx: SandboxContext,
  cliOptions: SandboxOptions,
  useVerboseTiming: boolean,
  silent: boolean,
): Promise<BuildImagesResult> {
  const logger = getLogger();
  displayConfigWarnings(silent);
  const hostInfo = await runtimeService.ensureHostSetup();
  checkRuntimeMemory(hostInfo.memoryBytes);

  const skipBuild = cliOptions.noBuild || cliOptions.build === false;
  const label = skipBuild ? "Image resolution" : "Image checks and builds";
  if (useVerboseTiming) logger.startTiming(label);
  const buildResult = skipBuild
    ? await resolveExistingFinalImage(runtimeService, ctx.projectRoot)
    : await buildImages(
        runtimeService,
        { projectRoot: ctx.projectRoot },
        silent,
      );
  if (useVerboseTiming) logger.endTiming(label);
  return buildResult;
}
