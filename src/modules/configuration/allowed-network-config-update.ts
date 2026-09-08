import * as path from "node:path";
import {
  ensureDirectory,
  readTextFile,
  writeTextFile,
} from "#platform/filesystem/index.js";

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

export function injectAllowedDomains(
  content: string,
  domains: string[],
): string {
  if (domains.length === 0) return content;
  const domainLines = domains.map((domain) => `  "${domain}",`).join("\n");
  if (/^\s*allow_network\s*=\s*\[/m.test(content)) {
    return content.replace(
      /^(\s*allow_network\s*=\s*\[[\s\S]*?)\]/m,
      (_, prefix: string) =>
        injectDomainsIntoAllowNetworkPrefix(prefix, domainLines),
    );
  }
  return `${content}\nallow_network = [\n${domainLines}\n]`;
}

export function readNetworkConfigFile(filePath: string): string {
  try {
    return readTextFile(filePath);
  } catch {
    return "";
  }
}

export function writeNetworkConfigFile(
  filePath: string,
  content: string,
): void {
  ensureDirectory(path.dirname(filePath));
  writeTextFile(filePath, content);
}
