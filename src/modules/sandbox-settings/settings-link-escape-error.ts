import path from "node:path";
import chalk from "chalk";
import {
  getGlobalConfigPath,
  hasGlobChars,
} from "#modules/configuration/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import {
  getPathType,
  readSymbolicLinkSync,
  realPathOrSelf,
} from "#platform/filesystem/index.js";
import { isPathInside } from "#shared/text/index.js";
import { getSettingsDir } from "./settings-paths.js";

/** A relative path in the settings directory and the pattern that selected it. */
export interface SettingsMatch {
  readonly path: string;
  readonly pattern: string;
}

interface EscapingSettingsLink {
  readonly pattern: string;
  readonly linkPath: string;
  readonly linkTarget: string;
  readonly mountSource: string;
  readonly mountPath: string;
}

/**
 * Find the outermost path component that resolves outside the settings
 * directory. Its last component is the link that causes the escape.
 */
function findEscapingLinkPath(
  resolvedSettingsDirectory: string,
  match: string,
): string {
  const parts = match.split("/");
  for (let length = 1; length < parts.length; length++) {
    const candidate = parts.slice(0, length).join("/");
    const realPath = realPathOrSelf(
      path.join(resolvedSettingsDirectory, candidate),
    );
    if (!isPathInside(realPath, resolvedSettingsDirectory)) return candidate;
  }
  return match;
}

/** Return the path components before the first glob component. */
function getStaticPatternBase(pattern: string): string {
  const parts = pattern.replace(/\/$/, "").split("/");
  const globIndex = parts.findIndex(hasGlobChars);
  return parts.slice(0, globIndex === -1 ? parts.length : globIndex).join("/");
}

function readLinkTarget(linkFullPath: string): string {
  if (getPathType(linkFullPath) === "symbolic-link") {
    return readSymbolicLinkSync(linkFullPath);
  }
  return realPathOrSelf(linkFullPath);
}

/**
 * Describe the link of a rejected match. The suggested mount keeps the scope
 * of the settings entry: the static pattern base, or the link if it is deeper.
 */
function describeEscapingLink(
  resolvedSettingsDirectory: string,
  match: SettingsMatch,
): EscapingSettingsLink {
  const linkPath = findEscapingLinkPath(resolvedSettingsDirectory, match.path);
  const linkFullPath = path.join(resolvedSettingsDirectory, linkPath);
  const linkTarget = readLinkTarget(linkFullPath);
  const resolvedLinkTarget = path.resolve(
    realPathOrSelf(path.dirname(linkFullPath)),
    linkTarget,
  );
  const patternBase = getStaticPatternBase(match.pattern);
  const mountPath =
    patternBase.length > linkPath.length ? patternBase : linkPath;
  return {
    pattern: match.pattern,
    linkPath,
    linkTarget,
    mountSource: path.join(
      resolvedLinkTarget,
      path.relative(linkPath, mountPath),
    ),
    mountPath,
  };
}

function findEscapingLinks(
  resolvedSettingsDirectory: string,
  matches: readonly SettingsMatch[],
): EscapingSettingsLink[] {
  const links = new Map<string, EscapingSettingsLink>();
  for (const match of matches) {
    const link = describeEscapingLink(resolvedSettingsDirectory, match);
    const key = `${link.pattern}\0${link.linkPath}`;
    if (!links.has(key)) links.set(key, link);
  }
  return [...links.values()];
}

function formatHostPath(hostPath: string, homeDirectory: string): string {
  if (!path.isAbsolute(hostPath) || !isPathInside(hostPath, homeDirectory)) {
    return hostPath;
  }
  const relativePath = path.relative(homeDirectory, hostPath);
  if (relativePath === "") return "~";
  return `~/${relativePath.split(path.sep).join("/")}`;
}

function formatLinkLines(
  links: readonly EscapingSettingsLink[],
  homeDirectory: string,
): string[] {
  const settingsDirectory = getSettingsDir();
  const entryWidth = Math.max(...links.map((link) => link.pattern.length + 2));
  return links.map((link) => {
    const entry = `~/${link.pattern}`.padEnd(entryWidth);
    const location = formatHostPath(
      path.join(settingsDirectory, link.linkPath),
      homeDirectory,
    );
    const target = formatHostPath(link.linkTarget, homeDirectory);
    return `  ${entry}  link ${chalk.dim(location)} -> ${chalk.dim(target)}`;
  });
}

function formatMountLines(
  links: readonly EscapingSettingsLink[],
  homeDirectory: string,
): string[] {
  const mounts = new Set(
    links.map(
      (link) =>
        `${formatHostPath(link.mountSource, homeDirectory)}:~/${link.mountPath}:rw`,
    ),
  );
  return [...mounts].map((mount) =>
    chalk.cyan(`     ${JSON.stringify(mount)},`),
  );
}

/**
 * Create one error for all mount-mode settings that resolve outside the
 * settings directory. The message shows each link once and `mounts` entries
 * that replace the links.
 */
export function createSettingsLinkEscapeError(
  resolvedSettingsDirectory: string,
  matches: readonly SettingsMatch[],
): Error {
  const homeDirectory = getHostEnvironment().homeDirectory;
  const links = findEscapingLinks(resolvedSettingsDirectory, matches);
  const settingsDirectory = chalk.dim(
    formatHostPath(getSettingsDir(), homeDirectory),
  );
  const configPath = chalk.dim(
    formatHostPath(getGlobalConfigPath(), homeDirectory),
  );
  return new Error(
    [
      "Sandbox did not start: settings links point outside the settings directory.",
      "",
      "Every container can write the settings directory. A container could create such a link",
      "and make Sandbox mount any host path. For this reason, Sandbox does not follow these links.",
      "",
      ...formatLinkLines(links, homeDirectory),
      "",
      "To fix:",
      `  1. Remove these entries from "settings" in ${configPath},`,
      "     or delete the links. Either step stops this error.",
      '  2. To keep access in the container, add mounts to the "mounts" list in the same file:',
      "",
      ...formatMountLines(links, homeDirectory),
      "",
      '     These mounts are writable. Use ":ro" if the tool only reads the files.',
      '     A mount must not use the same container path as an entry in "persist_paths" or "mounts".',
      "",
      "Did you not create these links? A container may have changed your settings.",
      `Delete the links and check ${settingsDirectory}.`,
    ].join("\n"),
  );
}
