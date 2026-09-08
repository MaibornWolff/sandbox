import type { RepositoryRoots } from "#platform/git/index.js";
import type { Config, RuntimeId } from "./config.js";

export interface LoadConfigResult {
  config: Config;
  projectRoot: string;
  repositoryRoots: RepositoryRoots;
  configuredRuntime?: RuntimeId;
}
