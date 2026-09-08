import * as path from "node:path";
import {
  hasGlobChars,
  type PersistPath,
} from "#modules/configuration/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { ensurePath, exists } from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import { normalizePath, windowsPathToDocker } from "#shared/text/index.js";
import { expandGlob } from "./glob-expansion.js";
import type { PersistentMount } from "./mount.js";
import {
  getGlobalPersistDir,
  getProjectPersistDir,
} from "./persistence-paths.js";
import { resolvePersistentPaths } from "./persistent-path-mapping.js";

export interface PersistentMountsResult {
  mounts: PersistentMount[];
}

/**
 * Process a single persist path and return a mount if valid
 */
async function processPersistPath(
  p: PersistPath,
  baseDir: string,
  containerProjectPath: string,
  projectPath: string,
): Promise<PersistentMount | null> {
  const logger = getLogger();
  const resolved = resolvePersistentPaths(
    p.path,
    containerProjectPath,
    baseDir,
    projectPath,
  );
  if (!resolved) {
    return null;
  }

  // Check onlyIfExists - skip if the original host path doesn't exist
  if (p.onlyIfExists) {
    const pathExists = await exists(resolved.originHostPath);
    if (!pathExists) {
      logger.debug(
        `Persist: skipping ${p.path} (only_if_exists=true, host path not found)`,
      );
      return null;
    }
  }

  // Ensure the persist path exists on host
  const created = await ensurePath(resolved.hostPath, p.default);
  if (created) {
    const msg =
      p.default !== undefined
        ? `Persist: created file ${resolved.hostPath} with default content`
        : `Persist: created directory ${resolved.hostPath}`;
    logger.debug(msg);
  } else {
    logger.debug(`Persist: ${resolved.hostPath} already exists`);
  }

  const scope = p.global ? "global" : "project";
  logger.debug(
    `Persist: ${p.path} → host:${resolved.hostPath} container:${resolved.containerPath} (${scope})`,
  );

  return {
    hostPath: resolved.hostPath,
    containerPath: resolved.containerPath,
    mode: "rw",
  };
}

interface ProcessContext {
  projectPath: string;
  projectBaseDir: string;
  globalBaseDir: string;
  containerProjectPath: string;
}

interface ProcessResult {
  mounts: PersistentMount[];
  globalCount: number;
  projectCount: number;
}

/**
 * Process a glob pattern and return mounts for all matches.
 * Glob patterns only match project-relative paths, so they always use projectBaseDir.
 */
async function processGlobPath(
  p: PersistPath,
  ctx: ProcessContext,
): Promise<ProcessResult> {
  const logger = getLogger();
  const result: ProcessResult = { mounts: [], globalCount: 0, projectCount: 0 };

  const expandedPaths = await expandGlob({
    cwd: ctx.projectPath,
    pattern: p.path,
  });

  const dataHome = getHostEnvironment().dataHomeDirectory;
  const sandboxDataDir = path.join(dataHome, "sandbox");

  for (const expandedPath of expandedPaths) {
    // Filter: skip paths that resolve into sandbox persist storage
    const resolvedHostPath = normalizePath(
      path.resolve(ctx.projectPath, expandedPath.slice(2)),
    );
    const normalizedSandboxDataDir = normalizePath(sandboxDataDir);
    if (resolvedHostPath.startsWith(normalizedSandboxDataDir)) {
      logger.debug(
        `Persist: skipping glob match ${expandedPath} (inside sandbox data dir)`,
      );
      continue;
    }
    // Create a new PersistPath with the literal expanded path.
    // We explicitly set onlyIfExists to false because:
    // 1. Glob only matches paths that exist in the project
    // 2. onlyIfExists checks the persist STORAGE, not the project directory
    // 3. We want to create new persist storage for matched paths
    const literalPath: PersistPath = {
      ...p,
      path: expandedPath,
      onlyIfExists: false,
    };
    const mount = await processPersistPath(
      literalPath,
      ctx.projectBaseDir,
      ctx.containerProjectPath,
      ctx.projectPath,
    );
    if (mount) {
      result.mounts.push(mount);
      result.projectCount++;
    }
  }

  return result;
}

/**
 * Process a literal (non-glob) path and return mount if valid.
 */
async function processLiteralPath(
  p: PersistPath,
  ctx: ProcessContext,
): Promise<ProcessResult> {
  const result: ProcessResult = { mounts: [], globalCount: 0, projectCount: 0 };

  const baseDir = p.global ? ctx.globalBaseDir : ctx.projectBaseDir;
  const mount = await processPersistPath(
    p,
    baseDir,
    ctx.containerProjectPath,
    ctx.projectPath,
  );

  if (mount) {
    result.mounts.push(mount);
    if (p.global) {
      result.globalCount++;
    } else {
      result.projectCount++;
    }
  }

  return result;
}

/**
 * Get the persist volume mounts for the container.
 *
 * Each persist path gets its own direct mount instead of using symlinks.
 * This simplifies the container setup and avoids issues with host directories.
 *
 * Storage layout:
 *   ~/.local/share/sandbox/global/{path}      - global paths (shared across projects)
 *   ~/.local/share/sandbox/{project-slug}/{path} - project paths (isolated per project)
 *
 * @param projectPath - The path to the project root
 * @param persistPaths - Paths to persist (from config)
 * @returns Object with mounts array
 */
export async function getPersistentMounts(
  projectPath: string,
  persistPaths: PersistPath[],
): Promise<PersistentMountsResult> {
  const logger = getLogger();
  logger.startTiming("Setup persistent mounts");

  if (persistPaths.length === 0) {
    logger.debug("Persist: no paths configured");
    logger.endTiming("Setup persistent mounts");
    return { mounts: [] };
  }

  const projectBaseDir = getProjectPersistDir(projectPath);
  const ctx: ProcessContext = {
    projectPath,
    projectBaseDir,
    globalBaseDir: getGlobalPersistDir(),
    containerProjectPath: windowsPathToDocker(projectPath),
  };

  logger.debug(`Persist: global base: ${ctx.globalBaseDir}`);
  logger.debug(`Persist: project base: ${ctx.projectBaseDir}`);

  const mounts: PersistentMount[] = [];
  let globalCount = 0;
  let projectCount = 0;

  for (const p of persistPaths) {
    // Named-volume entries are mounted as Docker named volumes by the run
    // layer; a bind mount here would duplicate the container mount point.
    if (p.useNamedVolume) {
      logger.debug(
        `Persist: skipping ${p.path} (handled as named volume ${p.useNamedVolume})`,
      );
      continue;
    }
    const result = hasGlobChars(p.path)
      ? await processGlobPath(p, ctx)
      : await processLiteralPath(p, ctx);

    mounts.push(...result.mounts);
    globalCount += result.globalCount;
    projectCount += result.projectCount;
  }

  // Deduplicate by containerPath (user config is applied before project config,
  // so first occurrence wins — same path from both configs uses the same host path)
  const seen = new Set<string>();
  const dedupedMounts = mounts.filter((m) => {
    if (seen.has(m.containerPath)) {
      logger.debug(`Persist: deduplicating ${m.containerPath}`);
      return false;
    }
    seen.add(m.containerPath);
    return true;
  });

  logger.debug(
    `Persist: ${dedupedMounts.length} mounts configured (${globalCount} global, ${projectCount} project)`,
  );
  logger.endTiming("Setup persistent mounts");

  return { mounts: dedupedMounts };
}
