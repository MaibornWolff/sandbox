import { getConfigurationService } from "#modules/configuration/index.js";
import { getRuntimeProvider } from "#platform/container-runtime/index.js";
import { getLogger } from "#platform/logging/index.js";
import { buildImages } from "./build/image-build-execution.js";
import type {
  BuildCommandOptions,
  LayerType,
} from "./image-build-contracts.js";

class InvalidBuildOptionsError extends Error {
  readonly exitCode = 1;
  readonly reported = true;
}

/**
 * Resolve target layer from CLI flags
 * Returns undefined if no target specified (build all)
 * Returns layer type if specific target requested
 * Returns null if invalid combination detected
 */
function resolveTargetLayer(
  options: BuildCommandOptions,
): LayerType | undefined | null {
  if (options.user && options.project) {
    return null; // Invalid combination
  }
  if (options.user) return "user";
  if (options.project) return "project";
  return undefined;
}

/**
 * Shared implementation for build and upgrade commands
 */
async function runBuild(
  options: BuildCommandOptions,
  noCache: boolean,
): Promise<void> {
  const targetLayer = resolveTargetLayer(options);
  if (targetLayer === null) {
    getLogger().error("Cannot specify both --user and --project flags");
    throw new InvalidBuildOptionsError(
      "Cannot specify both --user and --project flags",
    );
  }
  const { projectRoot, runtimeResolution } =
    await getConfigurationService().load(options);
  const service = await getRuntimeProvider().resolve(runtimeResolution);
  await buildImages(service, {
    targetLayer,
    buildTrigger: noCache ? "always" : "if-needed",
    cacheStrategy: noCache ? "none" : "native",
    projectRoot,
  });
}

/**
 * Build command handler - builds Docker images using native cache
 */
export async function buildCommand(
  options: BuildCommandOptions,
): Promise<void> {
  await runBuild(options, options.cache === false);
}

/**
 * Upgrade command handler - rebuilds images with --no-cache using native cache
 */
export async function upgradeCommand(
  options: BuildCommandOptions = {},
): Promise<void> {
  await runBuild(options, true);
}
