import * as path from "node:path";
import {
  ensureDirectory,
  pathExists,
  readTextFile,
  writeTextFileAtomically,
} from "#platform/filesystem/index.js";
import { parseAllowedNetwork } from "./config-value-parsing.js";
import { injectTomlArrayEntries } from "./toml-array-injection.js";

const NETWORK_ENTRY_PATTERN =
  /^(\*\.)?[a-z0-9.-]+(:(\d+|\*|\{[\d,\s*]+\}))?$/iu;

/**
 * Reject entries that are not plain `host[:ports]` values. Entries come from
 * sandbox logs, so a hostile name could otherwise smuggle TOML syntax into
 * the config file.
 */
function assertNetworkEntry(entry: string): void {
  if (!NETWORK_ENTRY_PATTERN.test(entry)) {
    throw new Error(`Invalid network entry: ${JSON.stringify(entry)}`);
  }
  parseAllowedNetwork(entry);
}

export function injectAllowedDomains(
  content: string,
  domains: string[],
): string {
  if (domains.length === 0) return content;
  for (const domain of domains) assertNetworkEntry(domain);
  const domainLines = domains.map((domain) => `  "${domain}",`).join("\n");
  return injectTomlArrayEntries(content, "allow_network", domainLines);
}

export function readNetworkConfigFile(filePath: string): string {
  if (!pathExists(filePath)) return "";
  return readTextFile(filePath);
}

export function writeNetworkConfigFile(
  filePath: string,
  content: string,
): void {
  ensureDirectory(path.dirname(filePath));
  writeTextFileAtomically(filePath, content);
}
