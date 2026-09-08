import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDirectoryPath, pathExists } from "#platform/filesystem/index.js";
import { ExecError, getProcessManager } from "#platform/process/index.js";
import { normalizePath } from "#shared/text/index.js";

async function executeGit(args: readonly string[]): Promise<string> {
  const result = await getProcessManager().start({
    command: "git",
    args,
    lifetime: "application",
    interaction: { mode: "non-interactive" },
    stdio: "capture",
  }).result;
  if (result.exitCode !== 0) {
    throw new ExecError(
      `Git exited with code ${result.exitCode}`,
      result.exitCode,
      {
        stdout: result.stdout,
        stderr: result.stderr,
      },
    );
  }
  return result.stdout;
}

/**
 * Check if a path is inside another directory (not equal to it)
 */
function isInsideDir(child: string, parent: string): boolean {
  const rel = relative(normalizePath(parent), normalizePath(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Git roots resolved by one `rev-parse` process. */
export interface RepositoryRoots {
  readonly worktreeRoot: string | null;
  readonly mainRepoRoot: string | null;
}

async function resolveRepositoryRoots(
  projectPath: string,
): Promise<RepositoryRoots> {
  try {
    const result = await executeGit([
      "-C",
      projectPath,
      "rev-parse",
      "--show-toplevel",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const lines = result
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== "--path-format=absolute");
    const worktreeRoot = lines[0];
    const gitCommonDir = lines.at(-1);
    if (!worktreeRoot || !gitCommonDir) {
      return { worktreeRoot: null, mainRepoRoot: null };
    }
    const absoluteGitDir = isAbsolute(gitCommonDir)
      ? gitCommonDir
      : resolve(projectPath, gitCommonDir);
    return {
      worktreeRoot: normalizePath(worktreeRoot),
      mainRepoRoot: normalizePath(dirname(absoluteGitDir)),
    };
  } catch {
    return { worktreeRoot: null, mainRepoRoot: null };
  }
}

function findSandboxRoot(projectPath: string): string | null {
  let currentPath = projectPath;
  let previousPath = "";

  while (currentPath !== previousPath) {
    const markerPath = join(currentPath, ".sandbox");
    if (pathExists(markerPath) && isDirectoryPath(markerPath)) {
      return currentPath;
    }
    previousPath = currentPath;
    currentPath = normalizePath(dirname(currentPath));
  }

  return null;
}

/**
 * Get the raw Git repository root without any .sandbox-marker awareness.
 * For worktrees, returns the main repository root (same as getRepoRootPath
 * in the non-worktree case, but never stops early at a .sandbox marker).
 *
 * Returns null if not in a Git repository.
 */
export async function getGitRootPath(
  projectPath: string,
): Promise<string | null> {
  const normalizedPath = normalizePath(resolve(projectPath));
  return (await resolveRepositoryRoots(normalizedPath)).mainRepoRoot;
}

/**
 * Get the root path of a Git repository or project with .sandbox marker.
 *
 * For worktrees, returns the main repository root (not the worktree root)
 * so that git operations work correctly inside containers.
 *
 * @param projectPath - The path to check for a Git repository
 * @returns The root path of the repository, or projectPath if not a Git repo
 */
export async function resolveRepositoryContext(
  projectPath: string,
): Promise<RepositoryRoots & { readonly projectRoot: string }> {
  const normalizedPath = normalizePath(resolve(projectPath));
  const roots = await resolveRepositoryRoots(normalizedPath);
  const sandboxRoot = findSandboxRoot(normalizedPath);
  const gitRoot = roots.mainRepoRoot ?? roots.worktreeRoot;
  const projectRoot = sandboxRoot ?? gitRoot ?? normalizedPath;
  return {
    ...roots,
    projectRoot: isAbsolute(projectRoot)
      ? projectRoot
      : normalizePath(resolve(projectRoot)),
  };
}

export async function getRepoRootPath(projectPath: string): Promise<string> {
  return (await resolveRepositoryContext(projectPath)).projectRoot;
}

/**
 * Get the worktree path if in an external worktree (outside main repo).
 * Returns null if not in a worktree, or if worktree is inside main repo.
 *
 * External worktrees need separate mounts since they're not covered by
 * the main repo mount.
 *
 * @param projectPath - The path to check
 * @returns The worktree path if external, null otherwise
 */
export async function getExternalWorktreePath(
  projectPath: string,
  cached?: RepositoryRoots,
): Promise<string | null> {
  const normalizedPath = normalizePath(resolve(projectPath));
  const { worktreeRoot, mainRepoRoot } =
    cached ?? (await resolveRepositoryRoots(normalizedPath));

  // Not in a git repo
  if (!worktreeRoot || !mainRepoRoot) {
    return null;
  }

  // Not in a worktree (worktree root equals main repo root)
  if (worktreeRoot === mainRepoRoot) {
    return null;
  }

  // Worktree is inside main repo - no separate mount needed
  if (isInsideDir(worktreeRoot, mainRepoRoot)) {
    return null;
  }

  // External worktree - needs separate mount
  return worktreeRoot;
}
