import * as path from "node:path";
import chalk from "chalk";
import fg from "fast-glob";
import { getProjectDockerfilePath } from "#modules/configuration/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import {
  copyDirectory,
  copyFile,
  ensureDirectory,
  isDirectoryPath,
  pathExists,
  readTextFile,
} from "#platform/filesystem/index.js";
import { getGitRootPath } from "#platform/git/index.js";
import { writeStandardOutput } from "#platform/terminal/index.js";
import { getErrorMessage } from "#shared/errors/index.js";
import type { ToolDefinition } from "../tools/tool-definition.js";
import { TOOL_REGISTRY } from "../tools/tool-registry.js";

interface DetectedBuildContextFile {
  toolId: string;
  sourcePath: string;
  destination: string;
}

type BuildContextFileEntry = NonNullable<
  ToolDefinition["buildContextFiles"]
>[number];
type BuildContextTool = Pick<ToolDefinition, "id" | "buildContextFiles">;

/** @testonly */
export function parseToolIdsFromDockerfile(content: string): string[] | null {
  const match = /^# Tools:[ \t]*([^\r\n]*)$/m.exec(content);
  if (!match) return null;
  return (match[1] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export function readToolIdsFromDockerfile(
  dockerfilePath: string,
): string[] | null {
  if (!pathExists(dockerfilePath)) return null;
  return parseToolIdsFromDockerfile(readTextFile(dockerfilePath));
}

export function validateToolIds(
  toolIds: string[],
  registry: ToolDefinition[] = TOOL_REGISTRY,
): { valid: string[]; unknown: string[] } {
  const registryIds = new Set(registry.map((tool) => tool.id));
  const valid: string[] = [];
  const unknown: string[] = [];
  for (const id of toolIds) {
    if (registryIds.has(id)) valid.push(id);
    else unknown.push(id);
  }
  return { valid, unknown };
}

/** @testonly */
export function getDetectedToolIds(
  detectedFiles: DetectedBuildContextFile[],
): string[] {
  return [...new Set(detectedFiles.map((file) => file.toolId))];
}

function isGlobPattern(pattern: string): boolean {
  return /[*?{[]/.test(pattern);
}

async function resolveGlobPattern(
  pattern: string,
  destinationPrefix: string,
  searchRoot: string,
): Promise<Array<{ sourcePath: string; destination: string }>> {
  const matches = await fg.glob(pattern, {
    cwd: searchRoot,
    dot: true,
    onlyFiles: false,
  });
  matches.sort();
  return matches.map((match) => ({
    sourcePath: path.join(searchRoot, match),
    destination: path.join(destinationPrefix, match),
  }));
}

async function detectGlobEntry(
  toolId: string,
  entry: BuildContextFileEntry,
  cwd: string,
  gitRoot: string | null,
): Promise<DetectedBuildContextFile[]> {
  const { pattern, destination } = entry;
  const cwdMatches = await resolveGlobPattern(pattern, destination, cwd);
  if (cwdMatches.length > 0) {
    return cwdMatches.map((match) => ({ toolId, ...match }));
  }
  if (!gitRoot) return [];
  const rootMatches = await resolveGlobPattern(pattern, destination, gitRoot);
  return rootMatches.map((match) => ({ toolId, ...match }));
}

function detectLiteralEntry(
  toolId: string,
  entry: BuildContextFileEntry,
  cwd: string,
  gitRoot: string | null,
): DetectedBuildContextFile[] {
  const { pattern, destination } = entry;
  const cwdPath = path.join(cwd, pattern);
  if (pathExists(cwdPath)) {
    return [{ toolId, sourcePath: cwdPath, destination }];
  }
  if (!gitRoot) return [];
  const gitRootPath = path.join(gitRoot, pattern);
  return pathExists(gitRootPath)
    ? [{ toolId, sourcePath: gitRootPath, destination }]
    : [];
}

/** @testonly */
export async function detectBuildContextFiles(
  tools: BuildContextTool[],
  cwd = getHostEnvironment().currentWorkingDirectory,
): Promise<DetectedBuildContextFile[]> {
  const toolsWithFiles = tools.filter((tool) => tool.buildContextFiles?.length);
  if (toolsWithFiles.length === 0) return [];

  const gitRoot = await getGitRootPath(cwd);
  const detected: DetectedBuildContextFile[] = [];
  for (const tool of toolsWithFiles) {
    for (const entry of tool.buildContextFiles ?? []) {
      const entries = isGlobPattern(entry.pattern)
        ? await detectGlobEntry(tool.id, entry, cwd, gitRoot)
        : detectLiteralEntry(tool.id, entry, cwd, gitRoot);
      detected.push(...entries);
    }
  }
  return detected;
}

/** @testonly */
export function copyBuildContextFiles(
  detectedFiles: DetectedBuildContextFile[],
  cwd = getHostEnvironment().currentWorkingDirectory,
): void {
  for (const { sourcePath, destination } of detectedFiles) {
    const destPath = path.join(
      path.dirname(getProjectDockerfilePath(cwd)),
      destination,
    );
    try {
      ensureDirectory(path.dirname(destPath));
      if (isDirectoryPath(sourcePath)) copyDirectory(sourcePath, destPath);
      else copyFile(sourcePath, destPath);
      writeStandardOutput(
        `${chalk.green("✓")} Copied ${destination} to build context`,
      );
    } catch (error) {
      writeStandardOutput(
        `${chalk.yellow("⚠")} Failed to copy ${destination}: ${getErrorMessage(error)}`,
      );
    }
  }
}
