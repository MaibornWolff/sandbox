import {
  type PersistPathInput,
  RUNTIME_IDS,
  type RuntimeId,
} from "#modules/configuration/index.js";

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

const COMMENTED_RUNTIME_LINE = /^#\s*runtime\s*=\s*"[^"]*"[ \t]*$/m;

/**
 * Activate the commented runtime line in a TOML config template.
 * Leaves the template unchanged when no runtime is given.
 */
export function injectRuntime(content: string, runtime?: RuntimeId): string {
  if (!runtime) return content;
  const line = `runtime = "${runtime}"`;
  if (COMMENTED_RUNTIME_LINE.test(content)) {
    return content.replace(COMMENTED_RUNTIME_LINE, line);
  }
  return `${line}\n${content}`;
}

function isRuntimeId(value: string): value is RuntimeId {
  return RUNTIME_IDS.some((id) => id === value);
}

/**
 * Read the active top-level runtime from TOML config text.
 * Ignores comments, values in tables, and unknown runtime IDs.
 */
export function readActiveRuntime(content: string): RuntimeId | undefined {
  for (const line of content.split(/\r?\n/)) {
    const valueOnly = stripInlineComment(line).trim();
    if (valueOnly.startsWith("[")) return undefined;
    const match = valueOnly.match(/^runtime\s*=\s*"([^"]*)"$/);
    if (match?.[1] !== undefined) {
      return isRuntimeId(match[1]) ? match[1] : undefined;
    }
  }
  return undefined;
}
