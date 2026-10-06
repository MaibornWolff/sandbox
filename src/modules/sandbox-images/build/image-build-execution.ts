import * as path from "node:path";
import type {
  SandboxImage,
  SandboxRuntimeSelection,
} from "#platform/container-runtime/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { listFilesRecursively } from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import { readState, writeState } from "#platform/state/index.js";
import { warnIfNoSpaceError } from "../disk-space-diagnostics.js";
import type {
  BuildImagesOptions,
  BuildImagesResult,
  BuildTrigger,
  CacheStrategy,
} from "../image-build-contracts.js";
import {
  removeUnusedManagedImages,
  SANDBOX_MANAGED_IMAGE_LABEL,
} from "../image-cleanup.js";
import { getFinalImage } from "./final-image-selection.js";

type SandboxImageServices = SandboxRuntimeSelection;

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
  service: SandboxImageServices,
  noCache: boolean,
  dockerfileHash: string,
  silent: boolean,
): Promise<SandboxImage> {
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

  const image = await service.imageBuilder.build({
    tag: imageName,
    dockerfilePath,
    contextDirectory: dockerfileDir,
    buildArguments: buildArgs,
    labels: {
      "dockerfile.hash": dockerfileHash,
      [SANDBOX_MANAGED_IMAGE_LABEL]: "true",
    },
    secrets: githubToken
      ? [{ id: "GITHUB_TOKEN", environmentVariable: "GITHUB_TOKEN" }]
      : [],
    cachePolicy: noCache ? "bypass" : "use",
    output: silent ? "silent" : "interactive",
  });

  const state = readState();
  const stateKey = `${service.imageOwnershipKey}:${imageName}`;
  const previousImage = state.sandboxImages?.[stateKey];
  const ownedDigests = new Set(previousImage?.ownedDigests ?? []);
  if (previousImage && previousImage.digest !== image.digest) {
    ownedDigests.add(previousImage.digest);
  }
  writeState({
    sandboxImages: {
      ...state.sandboxImages,
      [stateKey]: {
        ...image,
        labels: {
          "dockerfile.hash": dockerfileHash,
          [SANDBOX_MANAGED_IMAGE_LABEL]: "true",
        },
        ...(ownedDigests.size > 0 ? { ownedDigests: [...ownedDigests] } : {}),
      },
    },
  });
  logger.debug(`Successfully resolved immutable image ${image.digest}`);
  return image;
}

function getBuildPolicyLog(
  buildTrigger: BuildTrigger,
  cacheStrategy: CacheStrategy,
): string {
  return `trigger=${buildTrigger}, cache=${cacheStrategy}`;
}

async function executeBuildPlan(
  plan: BuildPlan,
  service: SandboxImageServices,
  silent: boolean,
): Promise<{ readonly image: SandboxImage; readonly builtAny: boolean }> {
  let finalImage: SandboxImage | undefined;

  for (const entry of plan.layers) {
    const { layer, state } = entry;
    if (!state.shouldBuild) {
      continue;
    }

    try {
      finalImage = await buildFromDockerfilePath(
        layer.dockerfilePath,
        layer.imageName,
        service,
        state.forceNoCache,
        state.expectedHash,
        silent,
      );
      state.currentLabelHash = state.expectedHash;
      state.imageExists = true;
    } catch (err) {
      warnIfNoSpaceError(err, service.runtime);
      throw createBuildFailure(err, layer.imageName);
    }
  }

  if (finalImage) return { image: finalImage, builtAny: true };
  if (!plan.finalImage) throw new Error("The image build plan is empty.");
  return { image: plan.finalImage, builtAny: false };
}

/**
 * Cleanup dangling images after a successful build
 * Non-fatal - logs warning but doesn't block build
 */
async function cleanupDanglingImagesAfterBuild(
  service: SandboxImageServices,
): Promise<void> {
  const logger = getLogger();
  try {
    const stats = await removeUnusedManagedImages(service);
    if (stats.removed > 0) {
      logger.info(`Cleaned ${stats.removed} old images (${stats.freedSpace})`);
    }
  } catch (err) {
    logger.warn(`Image cleanup failed: ${err}`);
  }
}

/**
 * Build all image layers (base → user → project)
 */
export async function buildImages(
  service: SandboxImageServices,
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

  logger.debug(
    `Runtime: ${service.runtime.runtime}, Silent: ${silent}, Target: ${targetLayer || "all"}, Policy: ${getBuildPolicyLog(buildTrigger, cacheStrategy)}`,
  );
  logger.debug(`Resolved project root: ${projectRoot}`);

  const plan = await planLayerBuilds(service.runtime, {
    projectRoot,
    targetLayer,
    buildTrigger,
    cacheStrategy,
  });
  const execution = await executeBuildPlan(plan, service, silent);

  if (!silent && execution.builtAny && cacheStrategy === "none") {
    logger.success("All layers rebuilt with fresh packages");
  }
  if (execution.builtAny) await cleanupDanglingImagesAfterBuild(service);

  const imageName = getFinalImage(projectRoot);

  logger.endTiming("Build images");
  logger.debug("Build images completed");

  return { imageName, image: execution.image };
}
