import type { RuntimeResolutionRequest } from "#platform/container-runtime/index.js";
import type { RepositoryRoots } from "#platform/git/index.js";
import type { Config } from "./config.js";

export interface LoadConfigResult {
  config: Config;
  projectRoot: string;
  repositoryRoots: RepositoryRoots;
  runtimeResolution: RuntimeResolutionRequest;
}
