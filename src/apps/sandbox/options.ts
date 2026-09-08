import type { ConfigOverrides } from "#modules/configuration/index.js";

export type AppGlobalOptions = ConfigOverrides & {
  verbose?: boolean;
  silent?: boolean;
  containerReuse?: boolean;
  noBuild?: boolean;
  build?: boolean;
};
