import type { Config } from "#modules/configuration/index.js";
import type { RepositoryRoots } from "#platform/git/index.js";

export interface SandboxContext {
  config: Config;
  projectRoot: string;
  repositoryRoots: RepositoryRoots;
}
