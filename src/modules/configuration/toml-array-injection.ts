function stripInlineComment(line: string): string {
  return line.replace(/#.*$/, "").trimEnd();
}

function findLastArrayValueLineIndex(lines: string[]): number | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const valueOnly = stripInlineComment(lines[index] ?? "");
    if (valueOnly.trim() === "") continue;
    if (valueOnly.endsWith("[")) break;
    return index;
  }
  return null;
}

function appendTrailingComma(line: string): string {
  const commentMatch = line.match(/^(.*?)(\s*#.*)$/);
  if (!commentMatch) return `${line},`;
  return `${(commentMatch[1] ?? "").trimEnd()},${commentMatch[2] ?? ""}`;
}

function closeArrayWithEntries(prefix: string, entryLines: string): string {
  const lines = prefix.trimEnd().split("\n");
  const lastValueIndex = findLastArrayValueLineIndex(lines);
  if (lastValueIndex !== null) {
    const valueLine = lines[lastValueIndex] ?? "";
    if (!stripInlineComment(valueLine).endsWith(",")) {
      lines[lastValueIndex] = appendTrailingComma(valueLine);
    }
  }
  return `${lines.join("\n")}\n${entryLines}\n]`;
}

/**
 * Find the offset of the closing bracket of the first uncommented top-level
 * `key = [` array. Brackets inside comments are ignored.
 */
function findArrayCloseOffset(content: string, key: string): number | null {
  const startPattern = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*\\[`);
  let offset = 0;
  let searchFrom: number | null = null;
  for (const line of content.split("\n")) {
    if (searchFrom === null) {
      const start = startPattern.exec(line);
      if (start) searchFrom = start[0].length;
    }
    if (searchFrom !== null) {
      const close = stripInlineComment(line).indexOf("]", searchFrom);
      if (close !== -1) return offset + close;
      searchFrom = 0;
    }
    offset += line.length + 1;
  }
  return null;
}

function appendTopLevelArray(
  content: string,
  key: string,
  entryLines: string,
): string {
  const block = `${key} = [\n${entryLines}\n]`;
  const firstTable = /^[ \t]*\[/m.exec(content);
  if (!firstTable) return `${content}\n${block}`;
  const before = content.slice(0, firstTable.index);
  const after = content.slice(firstTable.index);
  return `${before.trimEnd()}\n\n${block}\n\n${after}`;
}

/**
 * Add entry lines to the top-level TOML array `key`. An existing uncommented
 * array is extended before its closing bracket. Otherwise a new array is
 * placed before the first table header so that it stays top-level.
 */
export function injectTomlArrayEntries(
  content: string,
  key: string,
  entryLines: string,
): string {
  const closeOffset = findArrayCloseOffset(content, key);
  if (closeOffset === null) {
    return appendTopLevelArray(content, key, entryLines);
  }
  const prefix = content.slice(0, closeOffset);
  const rest = content.slice(closeOffset + 1);
  return `${closeArrayWithEntries(prefix, entryLines)}${rest}`;
}
