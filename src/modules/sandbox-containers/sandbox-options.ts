import type { ConfigOverrides } from "#modules/configuration/index.js";

export interface SandboxOptions extends ConfigOverrides {
  verbose?: boolean;
  silent?: boolean;
  containerReuse?: boolean;
  noBuild?: boolean;
  build?: boolean;
}

export interface CleanOptions extends SandboxOptions {
  all?: boolean;
  data?: boolean;
  force?: boolean;
}

export interface StopOptions extends SandboxOptions {
  all?: boolean;
  force?: boolean;
}
