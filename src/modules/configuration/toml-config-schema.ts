import { z } from "zod/v4";
import type {
  PersistPath,
  PersistPathInput,
  SettingsEntry,
  SettingsEntryInput,
} from "./config.js";
import { CONFIG_FIELD_CATALOG } from "./config-field-catalog.js";

function catalogSchemas<
  Catalog extends Record<string, { readonly schema: z.ZodType }>,
>(catalog: Catalog): { [Key in keyof Catalog]: Catalog[Key]["schema"] } {
  return Object.fromEntries(
    Object.entries(catalog).map(([key, field]) => [key, field.schema]),
  ) as { [Key in keyof Catalog]: Catalog[Key]["schema"] };
}

/** Zod schema derived from the central configuration field catalog. */
export const tomlConfigSchema = z.strictObject(
  catalogSchemas(CONFIG_FIELD_CATALOG),
);

export type TomlConfig = z.infer<typeof tomlConfigSchema>;

export function normalizePersistPath(input: PersistPathInput): PersistPath {
  return {
    path: input.path,
    default: input.default,
    global: input.global ?? false,
    onlyIfExists: input.only_if_exists ?? false,
    useNamedVolume: input.use_named_volume,
  };
}

export function normalizeSettingsPattern(pattern: string): string {
  if (pattern.startsWith("!~/")) {
    return `!${pattern.slice(3)}`;
  }
  if (pattern.startsWith("~/")) {
    return pattern.slice(2);
  }
  return pattern;
}

export function normalizeSettingsEntry(
  input: SettingsEntryInput,
): SettingsEntry {
  const path = typeof input === "string" ? input : input.path;
  return {
    path: normalizeSettingsPattern(path),
    mode: typeof input === "string" ? "mount" : (input.mode ?? "mount"),
  };
}
