type Quote = '"' | "'";

/** Advance past one character inside a string. Returns the next index and the open quote, if any. */
function stepInsideString(
  line: string,
  index: number,
  quote: Quote,
): { readonly next: number; readonly quote: Quote | null } {
  const char = line[index];
  if (char === "\\" && quote === '"') return { next: index + 2, quote };
  if (char === quote) return { next: index + 1, quote: null };
  return { next: index + 1, quote };
}

/**
 * Find the first occurrence of `target` in `line` at or after `from` that is
 * outside TOML basic (`"..."`, with backslash escapes) and literal (`'...'`)
 * strings and before any comment. Returns -1 when there is none.
 */
function indexOutsideStrings(
  line: string,
  target: "#" | "]",
  from = 0,
): number {
  let quote: Quote | null = null;
  let index = from;
  while (index < line.length) {
    const char = line[index];
    if (quote !== null) {
      ({ next: index, quote } = stepInsideString(line, index, quote));
      continue;
    }
    if (char === "#") return target === "#" ? index : -1;
    if (char === target) return index;
    if (char === '"' || char === "'") quote = char;
    index += 1;
  }
  return -1;
}

function stripInlineComment(line: string): string {
  const commentIndex = indexOutsideStrings(line, "#");
  return (commentIndex === -1 ? line : line.slice(0, commentIndex)).trimEnd();
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
  const commentIndex = indexOutsideStrings(line, "#");
  if (commentIndex === -1) return `${line},`;
  const value = line.slice(0, commentIndex);
  return `${value.trimEnd()},${value.slice(value.trimEnd().length)}${line.slice(commentIndex)}`;
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
 * `key = [` array. Brackets inside comments and strings are ignored.
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
      const close = indexOutsideStrings(line, "]", searchFrom);
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
