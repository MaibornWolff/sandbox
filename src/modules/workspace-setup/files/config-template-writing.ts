import {
  injectTomlArrayEntries,
  type PersistPathInput,
} from "#modules/configuration/index.js";

/**
 * Inject persist_paths entries into a TOML config string.
 * Skips entries whose use_named_volume value is already present.
 * Injects into an existing uncommented persist_paths array, or appends a new block.
 */
export function injectNamedVolumePersistPaths(
  content: string,
  paths: PersistPathInput[],
): string {
  if (paths.length === 0) return content;

  const toInject = paths.filter(
    (p) =>
      !p.use_named_volume ||
      !content.includes(`use_named_volume = "${p.use_named_volume}"`),
  );
  if (toInject.length === 0) return content;

  const entries = toInject
    .map((p) => {
      const parts: string[] = [`path = "${p.path}"`];
      if (p.use_named_volume)
        parts.push(`use_named_volume = "${p.use_named_volume}"`);
      return `  { ${parts.join(", ")} },`;
    })
    .join("\n");

  return injectTomlArrayEntries(content, "persist_paths", entries);
}
