import * as path from "node:path";
import { autoMigrateLegacyResources } from "#modules/sandbox-resources/index.js";
import type { ContainerRuntime } from "#platform/container-runtime/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { listFilesRecursively } from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import { warnIfNoSpaceError } from "../disk-space-diagnostics.js";
import type {
  BuildImagesOptions,
  BuildImagesResult,
  BuildTrigger,
  CacheStrategy,
} from "../image-build-contracts.js";
import { removeDanglingImages } from "../image-cleanup.js";
import { getFinalImage } from "./final-image-selection.js";
import { type BuildPlan, planLayerBuilds } from "./image-build-planning.js";

/**
 * Layer build order - used to determine which layers to build
 */
class ImageBuildError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "ImageBuildError";
  }
}

function getBuildExitCode(error: unknown): number {
  if (
    error &&
    typeof error === "object" &&
    "exitCode" in error &&
    typeof error.exitCode === "number"
  ) {
    return error.exitCode;
  }
  return 1;
}

function createBuildFailure(err: unknown, imageName: string): ImageBuildError {
  const message = err instanceof Error ? err.message : String(err);
  return new ImageBuildError(
    `Failed to build ${imageName}\n${message}`,
    getBuildExitCode(err),
  );
}

/**
 * Build from a Dockerfile on disk
 */
async function buildFromDockerfilePath(
  dockerfilePath: string,
  imageName: string,
  service: ContainerRuntime,
  noCache: boolean,
  dockerfileHash: string,
  silent: boolean,
): Promise<void> {
  const dockerfileDir = path.dirname(dockerfilePath);

  const logger = getLogger();
  logger.debug(`Building from Dockerfile path: ${dockerfilePath}`);
  logger.debug(`Build context directory: ${dockerfileDir}`);

  try {
    const contextFiles = listFilesRecursively(dockerfileDir);
    logger.debug(`Build context contains ${contextFiles.length} files:`);
    for (const file of contextFiles) {
      logger.debug(
        `  - ${file.relativePath} (${file.content.byteLength} bytes)`,
      );
    }
  } catch (err) {
    logger.debug(`Could not list build context: ${err}`);
  }

  const buildArgs: Record<string, string> = {};
  const environment = getHostEnvironment();
  const configuredHostUid = environment.variables.SANDBOX_HOST_UID;
  const configuredHostGid = environment.variables.SANDBOX_HOST_GID;
  if (configuredHostUid && configuredHostGid) {
    buildArgs.HOST_UID = configuredHostUid;
    buildArgs.HOST_GID = configuredHostGid;
  }

  const githubToken = environment.variables.GITHUB_TOKEN;
  if (githubToken) {
    buildArgs.GITHUB_TOKEN = githubToken;
  }

  await service.buildImage({
    tag: imageName,
    dockerfilePath,
    contextDir: dockerfileDir,
    buildArgs,
    labels: { "dockerfile.hash": dockerfileHash },
    noCache,
    silent,
  });

  logger.debug(`Successfully built ${imageName}`);
}

function getBuildPolicyLog(
  buildTrigger: BuildTrigger,
  cacheStrategy: CacheStrategy,
): string {
  return `trigger=${buildTrigger}, cache=${cacheStrategy}`;
}

async function executeBuildPlan(
  plan: BuildPlan,
  service: ContainerRuntime,
  silent: boolean,
): Promise<boolean> {
  let builtAny = false;
  const logger = getLogger();

  for (const entry of plan.layers) {
    const { layer, state } = entry;
    if (!state.shouldBuild) {
      continue;
    }

    logger.info(`Building ${layer.imageName}...`);
    try {
      await buildFromDockerfilePath(
        layer.dockerfilePath,
        layer.imageName,
        service,
        state.forceNoCache,
        state.expectedHash,
        silent,
      );
      logger.success(`Built ${layer.imageName}`);
      state.currentLabelHash = state.expectedHash;
      state.imageExists = true;
      builtAny = true;
    } catch (err) {
      warnIfNoSpaceError(err, service);
      throw createBuildFailure(err, layer.imageName);
    }
  }

  return builtAny;
}

/**
 * Cleanup dangling images after a successful build
 * Non-fatal - logs warning but doesn't block build
 */
async function cleanupDanglingImagesAfterBuild(
  service: ContainerRuntime,
): Promise<void> {
  const logger = getLogger();
  try {
    const stats = await removeDanglingImages(service);
    if (stats.removed > 0) {
      logger.info(`Cleaned ${stats.removed} old images (${stats.freedSpace})`);
    }
  } catch (err) {
    logger.warn(`Image cleanup failed: ${err}`);
  }
}

/**
 * Fetch the final image ID. Returns empty string on failure.
 */
async function fetchFinalImageId(
  service: ContainerRuntime,
  imageName: string,
): Promise<string> {
  try {
    return await service.getImageId(imageName);
  } catch {
    return "";
  }
}

/**
 * Build all image layers (base → user → project)
 */
export async function buildImages(
  service: ContainerRuntime,
  options: BuildImagesOptions,
  silent = false,
): Promise<BuildImagesResult> {
  const {
    targetLayer,
    buildTrigger = "if-needed",
    cacheStrategy = "native",
    projectRoot,
  } = options;

  const logger = getLogger();
  logger.debug("Starting Docker image build process");
  logger.startTiming("Build images");

  await autoMigrateLegacyResources(service, projectRoot);

  logger.debug(
    `Runtime: ${service.runtime}, Silent: ${silent}, Target: ${targetLayer || "all"}, Policy: ${getBuildPolicyLog(buildTrigger, cacheStrategy)}`,
  );
  logger.debug(`Resolved project root: ${projectRoot}`);

  const plan = await planLayerBuilds(service, {
    projectRoot,
    targetLayer,
    buildTrigger,
    cacheStrategy,
  });
  const builtAny = await executeBuildPlan(plan, service, silent);

  if (!silent && builtAny) {
    logger.success(
      cacheStrategy === "none"
        ? "All layers rebuilt with fresh packages"
        : "Build complete",
    );
  }

  if (builtAny) {
    await cleanupDanglingImagesAfterBuild(service);
  }

  const imageName = getFinalImage(projectRoot);
  const imageId = builtAny
    ? await fetchFinalImageId(service, imageName)
    : plan.finalImageId;

  logger.endTiming("Build images");
  logger.debug("Build images completed");

  return { imageName, imageId };
}
