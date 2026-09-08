import * as crypto from "node:crypto";
import * as path from "node:path";
import {
  getGlobalDockerfilePath,
  getProjectDockerfilePath,
} from "#modules/configuration/index.js";
import {
  BASE_IMAGE,
  getProjectImageName,
  USER_IMAGE,
} from "#modules/sandbox-resources/index.js";
import type { ContainerRuntime } from "#platform/container-runtime/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { pathExists } from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import { generateProjectSlug } from "#shared/text/index.js";
import type {
  BuildImagesOptions,
  BuildTrigger,
  LayerType,
} from "../image-build-contracts.js";
import { getDockerBuildContextDirectory } from "../sandbox-image-paths.js";
import { getImageHash } from "./build-context-hashing.js";

const LAYER_ORDER: LayerType[] = ["base", "user", "project"];

/**
 * Static image names for non-project layers
 */
const LAYER_IMAGE_NAMES: Record<Exclude<LayerType, "project">, string> = {
  base: BASE_IMAGE,
  user: USER_IMAGE,
};

/**
 * Parent layers are always base or user (project is never a parent).
 */
type ParentLayerType = Exclude<LayerType, "project">;

interface ResolvedLayer {
  type: LayerType;
  imageName: string;
  dockerfilePath: string;
  parentType?: LayerType;
  selected: boolean;
}

interface LayerInspection {
  imageId: string;
  currentLabelHash: string | null;
}

interface LayerState {
  localHash: string;
  currentLabelHash: string | null;
  expectedHash: string;
  imageExists: boolean;
  shouldBuild: boolean;
  forceNoCache: boolean;
}

interface LayerPlanEntry {
  layer: ResolvedLayer;
  state: LayerState;
}

export interface BuildPlan {
  layers: LayerPlanEntry[];
  finalImageId: string;
}

/**
 * Check if a layer should be built based on target layer
 */
function shouldBuildLayer(layer: LayerType, targetLayer?: LayerType): boolean {
  if (!targetLayer) return true;
  const targetIndex = LAYER_ORDER.indexOf(targetLayer);
  const currentIndex = LAYER_ORDER.indexOf(layer);
  return currentIndex >= targetIndex;
}

/**
 * Central dependency definition.
 * Returns the parent layer type, or undefined for base (root).
 */
function getParentLayer(
  layer: LayerType,
  userDockerfilePath: string,
): ParentLayerType | undefined {
  switch (layer) {
    case "base":
      return undefined;
    case "user":
      return "base";
    case "project":
      return pathExists(userDockerfilePath) ? "user" : "base";
  }
}

/**
 * Get all ancestor layers in build order (outermost first).
 */
function getAncestorLayers(
  layer: LayerType,
  userDockerfilePath: string,
): ParentLayerType[] {
  const ancestors: ParentLayerType[] = [];
  let current = getParentLayer(layer, userDockerfilePath);
  while (current) {
    ancestors.unshift(current);
    current = getParentLayer(current, userDockerfilePath);
  }
  return ancestors;
}

/**
 * Get the path to the docker/ directory
 * - In development: Returns path relative to source file
 * - In production: Returns path relative to compiled binary
 */
function getDockerDir(): string {
  const dockerDir = getDockerBuildContextDirectory();
  getLogger().debug(`Resolved docker directory: ${dockerDir}`);
  return dockerDir;
}

/**
 * Get the path to the base Dockerfile
 */
function getBaseDockerfilePath(): string {
  const dockerDir = getDockerDir();
  const dockerfilePath = path.join(dockerDir, "Dockerfile");

  getLogger().debug(`Base Dockerfile path: ${dockerfilePath}`);

  return dockerfilePath;
}

function isValidDockerfileHash(value: string | null): value is string {
  return value !== null && /^[a-f0-9]{12}$/u.test(value);
}

function combineBuildInputHashes(...inputs: readonly string[]): string {
  const hash = crypto.createHash("sha256");
  for (const input of inputs) hash.update(input);
  return hash.digest("hex").substring(0, 12);
}

function computeBaseBuildInputHash(localHash: string): string {
  const variables = getHostEnvironment().variables;
  const uid = variables.SANDBOX_HOST_UID;
  const gid = variables.SANDBOX_HOST_GID;
  if (!uid || !gid) return localHash;
  return combineBuildInputHashes(
    localHash,
    `HOST_UID=${uid}`,
    `HOST_GID=${gid}`,
  );
}

function computeExpectedHash(
  localHash: string,
  parentExpectedHash?: string,
): string {
  return parentExpectedHash
    ? combineBuildInputHashes(localHash, parentExpectedHash)
    : localHash;
}

/**
 * Context for building or checking project layer
 */
interface ProjectLayerContext {
  projectDockerfile: string;
  projectImage: string;
}

/**
 * Get context for project layer operations
 * Returns null if no project Dockerfile exists
 */
async function getProjectLayerContext(
  projectRoot: string,
): Promise<ProjectLayerContext | null> {
  const projectDockerfile = getProjectDockerfilePath(projectRoot);

  if (!pathExists(projectDockerfile)) {
    return null;
  }

  const slug = generateProjectSlug(projectRoot);
  const projectImage = getProjectImageName(slug);

  return { projectDockerfile, projectImage };
}

async function resolveLayers(
  userDockerfile: string,
  projectRoot: string,
  targetLayer?: LayerType,
): Promise<ResolvedLayer[]> {
  const baseDockerfilePath = getBaseDockerfilePath();
  const dockerDir = getDockerDir();

  if (!pathExists(dockerDir)) {
    throw new Error(
      `Docker directory not found: ${dockerDir}. Ensure docker/ directory is present alongside the binary.`,
    );
  }
  if (!pathExists(baseDockerfilePath)) {
    throw new Error(`Base Dockerfile not found: ${baseDockerfilePath}`);
  }

  const layers: ResolvedLayer[] = [
    {
      type: "base",
      imageName: LAYER_IMAGE_NAMES.base,
      dockerfilePath: baseDockerfilePath,
      selected: shouldBuildLayer("base", targetLayer),
    },
  ];

  if (pathExists(userDockerfile)) {
    layers.push({
      type: "user",
      imageName: LAYER_IMAGE_NAMES.user,
      dockerfilePath: userDockerfile,
      parentType: "base",
      selected: shouldBuildLayer("user", targetLayer),
    });
  }

  const projectLayer = await getProjectLayerContext(projectRoot);
  if (projectLayer) {
    layers.push({
      type: "project",
      imageName: projectLayer.projectImage,
      dockerfilePath: projectLayer.projectDockerfile,
      parentType: getParentLayer("project", userDockerfile),
      selected: shouldBuildLayer("project", targetLayer),
    });
  }

  return layers;
}

async function inspectLayers(
  layers: ResolvedLayer[],
  service: ContainerRuntime,
): Promise<Map<LayerType, LayerInspection>> {
  const inspectionEntries = await Promise.all(
    layers.map(async (layer) => {
      const inspection = await service.inspectImage(layer.imageName, [
        "dockerfile.hash",
      ]);
      return [
        layer.type,
        {
          imageId: inspection?.id ?? "",
          currentLabelHash: inspection?.labels["dockerfile.hash"] ?? null,
        },
      ] as const;
    }),
  );

  return new Map(inspectionEntries);
}

function shouldBuildLayerEntry(options: {
  layer: ResolvedLayer;
  inspection: LayerInspection;
  expectedHash: string;
  buildTrigger: BuildTrigger;
  targetLayer?: LayerType;
}): boolean {
  const { layer, inspection, expectedHash, buildTrigger, targetLayer } =
    options;

  const isAncestorOnly = !layer.selected && targetLayer !== undefined;
  const labelIsValid = isValidDockerfileHash(inspection.currentLabelHash);

  if (!inspection.imageId) {
    return true;
  }

  const logger = getLogger();
  if (!labelIsValid) {
    logger.debug(
      `Rebuild ${layer.imageName}: missing, empty, or malformed dockerfile.hash label`,
    );
    return true;
  }

  if (buildTrigger === "always" && !isAncestorOnly) {
    logger.debug(`Rebuild ${layer.imageName}: build trigger is always`);
    return true;
  }

  const needsRebuild = inspection.currentLabelHash !== expectedHash;
  logger.debug(`Image hash comparison for ${layer.imageName}:`);
  logger.debug(`  Expected hash: ${expectedHash}`);
  logger.debug(`  Current label: ${inspection.currentLabelHash}`);
  logger.debug(`  Needs rebuild: ${needsRebuild}`);
  return needsRebuild;
}

/**
 * @testonly
 */
export async function planLayerBuilds(
  service: ContainerRuntime,
  options: BuildImagesOptions,
): Promise<BuildPlan> {
  const {
    targetLayer,
    buildTrigger = "if-needed",
    projectRoot,
    cacheStrategy = "native",
  } = options;

  const userDockerfile = getGlobalDockerfilePath();
  const resolvedLayers = await resolveLayers(
    userDockerfile,
    projectRoot,
    targetLayer,
  );
  const inspection = await inspectLayers(resolvedLayers, service);

  const entries: LayerPlanEntry[] = [];
  const states = new Map<LayerType, LayerState>();

  for (const layer of resolvedLayers) {
    const parentExpectedHash = layer.parentType
      ? states.get(layer.parentType)?.expectedHash
      : undefined;
    const contextHash = getImageHash(layer.dockerfilePath);
    const localHash =
      layer.type === "base"
        ? computeBaseBuildInputHash(contextHash)
        : contextHash;
    const expectedHash = computeExpectedHash(localHash, parentExpectedHash);
    const currentInspection = inspection.get(layer.type);

    if (!currentInspection) {
      throw new Error(`Missing layer inspection for ${layer.type}`);
    }

    const state: LayerState = {
      localHash,
      currentLabelHash: currentInspection.currentLabelHash,
      expectedHash,
      imageExists: currentInspection.imageId.length > 0,
      shouldBuild: shouldBuildLayerEntry({
        layer,
        inspection: currentInspection,
        expectedHash,
        buildTrigger,
        targetLayer,
      }),
      forceNoCache: cacheStrategy === "none",
    };

    states.set(layer.type, state);
    entries.push({ layer, state });
  }

  return {
    layers: entries,
    finalImageId:
      inspection.get(resolvedLayers.at(-1)?.type ?? "base")?.imageId ?? "",
  };
}

/**
 * Collect all image names that need to be inspected for the invocation.
 * @testonly
 */
export function getImageNamesToInspect(
  userBasePath: string,
  projectRoot: string,
  targetLayer?: LayerType,
): string[] {
  const names = new Set<string>();

  names.add(LAYER_IMAGE_NAMES.base);

  const userDockerfile = path.join(userBasePath, "docker", "Dockerfile");
  if (pathExists(userDockerfile)) {
    names.add(LAYER_IMAGE_NAMES.user);
  }

  const projectDockerfile = getProjectDockerfilePath(projectRoot);
  if (
    pathExists(projectDockerfile) &&
    shouldBuildLayer("project", targetLayer)
  ) {
    names.add(getProjectImageName(generateProjectSlug(projectRoot)));
  }

  if (targetLayer) {
    const ancestors = getAncestorLayers(targetLayer, userDockerfile);
    for (const ancestor of ancestors) {
      names.add(LAYER_IMAGE_NAMES[ancestor]);
    }
  }

  return [...names];
}
