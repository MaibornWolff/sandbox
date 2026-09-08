import type { PersistPathInput } from "#modules/configuration/index.js";

function stripInlineComment(line: string): string {
  return line.replace(/#.*$/, "").trimEnd();
}

function findLastArrayValueLineIndex(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const valueOnly = stripInlineComment(lines[i] ?? "");
    if (valueOnly.trim() === "") continue;
    if (valueOnly.endsWith("[")) break;
    return i;
  }

  return null;
}

function appendTrailingComma(line: string): string {
  const commentMatch = line.match(/^(.*?)(\s*#.*)$/);
  if (!commentMatch) return `${line},`;

  const beforeComment = commentMatch[1] ?? "";
  const comment = commentMatch[2] ?? "";
  return `${beforeComment.trimEnd()},${comment}`;
}

function injectDomainsIntoAllowNetworkPrefix(
  prefix: string,
  domainLines: string,
): string {
  const lines = prefix.trimEnd().split("\n");
  const lastValueIndex = findLastArrayValueLineIndex(lines);

  if (lastValueIndex !== null) {
    const valueLine = lines[lastValueIndex] ?? "";
    if (!stripInlineComment(valueLine).endsWith(",")) {
      lines[lastValueIndex] = appendTrailingComma(valueLine);
    }
  }

  return `${lines.join("\n")}\n${domainLines}\n]`;
}

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

  if (/^\s*persist_paths\s*=\s*\[/m.test(content)) {
    return content.replace(
      /^(\s*persist_paths\s*=\s*\[[\s\S]*?)\]/m,
      (_, prefix: string) =>
        injectDomainsIntoAllowNetworkPrefix(prefix, entries),
    );
  }

  return `${content}\npersist_paths = [\n${entries}\n]`;
}
