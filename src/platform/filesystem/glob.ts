import {
  type GlobOptions,
  glob,
  Ignore,
  type IgnoreLike,
  type Path,
} from "glob";

interface GlobPathsOptions {
  readonly cwd: string;
  readonly dot?: boolean;
  readonly onlyDirectories?: boolean;
  readonly onlyFiles?: boolean;
  readonly followSymbolicLinks?: boolean;
  readonly ignore?: readonly string[];
}

function isExclusion(pattern: string): boolean {
  return pattern.startsWith("!") && !pattern.startsWith("!(");
}

function selectDirectoryContents(pattern: string): string {
  if (pattern === "**" || pattern.endsWith("/**")) return `${pattern}/*`;
  return pattern;
}

function createPathIgnore(
  patterns: string[],
  options: Pick<GlobOptions, "follow" | "nodir">,
): IgnoreLike {
  const ignore = new Ignore(patterns, { dot: true });
  return {
    ignored(entry) {
      if (ignore.ignored(entry)) return true;
      return Boolean(
        options.nodir && !options.follow && entry.isSymbolicLink(),
      );
    },
    childrenIgnored(entry) {
      // Glob's follow option alone still traverses links matched by a single star.
      if (!options.follow && entry.isSymbolicLink()) return true;
      return ignore.ignored(entry) || ignore.childrenIgnored(entry);
    },
  };
}

function relativePath(entry: Path): string {
  return entry.relativePosix() || ".";
}

/** Match paths without trailing slashes. A trailing `/**` selects contents, not the directory itself. */
export async function globPaths(
  patterns: string | readonly string[],
  options: GlobPathsOptions,
): Promise<string[]> {
  const entries = typeof patterns === "string" ? [patterns] : patterns;
  const includes: string[] = [];
  const excludes = [...(options.ignore ?? [])];
  for (const pattern of entries) {
    if (isExclusion(pattern)) {
      excludes.push(pattern.slice(1));
    } else {
      includes.push(selectDirectoryContents(pattern));
    }
  }
  const matching = {
    cwd: options.cwd,
    dot: options.dot,
    follow: options.followSymbolicLinks ?? true,
    nodir: options.onlyFiles ?? !options.onlyDirectories,
    withFileTypes: true as const,
  };
  const matches = await glob(includes, {
    ...matching,
    ignore: createPathIgnore(excludes, matching),
  });
  return matches
    .filter((entry) => !options.onlyDirectories || entry.isDirectory())
    .map(relativePath);
}
