/**
 * Layer types in the sandbox image hierarchy
 */
export type LayerType = "base" | "user" | "project";

/**
 * Build selection behavior
 */
export type BuildTrigger = "if-needed" | "always";

/**
 * Docker cache behavior during image builds
 */
export type CacheStrategy = "native" | "none";

import type { ConfigOverrides } from "#modules/configuration/index.js";

/**
 * Options for the build command CLI
 */
export interface BuildCommandOptions extends ConfigOverrides {
  /** Commander maps `--no-cache` to `cache: false` (negated-flag convention). */
  cache?: boolean;
  user?: boolean;
  project?: boolean;
}

/**
 * Options for buildImages() function
 */
export interface BuildImagesOptions {
  targetLayer?: LayerType;
  buildTrigger?: BuildTrigger;
  cacheStrategy?: CacheStrategy;
  projectRoot: string;
}

/**
 * Result from buildImages() - carries resolved names/IDs so callers
 * don't need to re-fetch them.
 */
export interface BuildImagesResult {
  imageName: string;
  imageId: string;
}
