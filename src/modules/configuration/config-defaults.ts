import type { Config, RuntimeId } from "./config.js";
import { createCatalogDefaults } from "./config-field-catalog.js";

/** Create a Config object with fresh array values from the field catalog. */
export function createConfigFromDefaults(
  runtime: RuntimeId,
  overrides?: Partial<Config>,
): Config {
  return {
    ...createCatalogDefaults(runtime),
    ...overrides,
  };
}
