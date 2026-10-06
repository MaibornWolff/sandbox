import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

export function pathExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function readTextFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

export function writeTextFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content);
}

export function readJsonRecord(filePath: string): Record<string, unknown> {
  if (!pathExists(filePath)) return {};

  try {
    return JSON.parse(readTextFile(filePath)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

type PathType = "file" | "directory" | "symbolic-link" | "other";

export function getPathType(filePath: string): PathType | null {
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) return "symbolic-link";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function isDirectoryPath(filePath: string): boolean {
  return fs.statSync(filePath).isDirectory();
}

export function isExecutableFile(
  filePath: string,
  operatingSystem: NodeJS.Platform,
): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    if (operatingSystem === "win32") return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function listDirectory(directoryPath: string): string[] {
  return fs.readdirSync(directoryPath);
}

export function copyFile(sourcePath: string, destinationPath: string): void {
  fs.copyFileSync(sourcePath, destinationPath);
}

export function copyDirectory(
  sourcePath: string,
  destinationPath: string,
): void {
  fs.cpSync(sourcePath, destinationPath, { recursive: true });
}

export function copyPathFollowingLinks(
  sourcePath: string,
  destinationPath: string,
): void {
  const source = fs.statSync(sourcePath);
  if (source.isDirectory()) {
    fs.cpSync(sourcePath, destinationPath, {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
    });
    return;
  }
  fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
}

export function createSymbolicLink(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath);
}

export function readSymbolicLinkSync(linkPath: string): string {
  return fs.readlinkSync(linkPath);
}

export function removePath(filePath: string): void {
  fs.rmSync(filePath, { recursive: true, force: true });
}

export function createTemporaryDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

export function createTemporaryDirectoryIn(
  parentDirectory: string,
  prefix: string,
): string {
  return fs.mkdtempSync(path.join(parentDirectory, prefix));
}

export function tryCreateDirectory(directoryPath: string): boolean {
  try {
    fs.mkdirSync(directoryPath);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

export function getPathModifiedTime(filePath: string): number {
  return fs.statSync(filePath).mtimeMs;
}

export function setPathModifiedTime(
  filePath: string,
  modifiedAt: number,
): void {
  const date = new Date(modifiedAt);
  fs.utimesSync(filePath, date, date);
}

export function setPathMode(filePath: string, mode: number): void {
  fs.chmodSync(filePath, mode);
}

export function renamePath(sourcePath: string, destinationPath: string): void {
  fs.renameSync(sourcePath, destinationPath);
}

export function realPathOrSelf(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

interface TextFileEntry {
  readonly relativePath: string;
  readonly content: string;
}

interface FileEntry {
  readonly relativePath: string;
  readonly kind: "file" | "symbolic-link";
  readonly content: Uint8Array;
}

export function listFilesRecursively(directory: string): FileEntry[] {
  const entries: FileEntry[] = [];

  function collect(currentDirectory: string): void {
    for (const entry of fs.readdirSync(currentDirectory, {
      withFileTypes: true,
    })) {
      const fullPath = path.join(currentDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        entries.push({
          relativePath: path
            .relative(directory, fullPath)
            .split(path.sep)
            .join("/"),
          kind: "symbolic-link",
          content: fs.readlinkSync(fullPath, { encoding: "buffer" }),
        });
      } else if (entry.isDirectory()) {
        collect(fullPath);
      } else if (entry.isFile()) {
        entries.push({
          relativePath: path
            .relative(directory, fullPath)
            .split(path.sep)
            .join("/"),
          kind: "file",
          content: fs.readFileSync(fullPath),
        });
      }
    }
  }

  collect(directory);
  return entries;
}

export function listTextFilesRecursively(directory: string): TextFileEntry[] {
  const entries: TextFileEntry[] = [];

  function collect(currentDirectory: string): void {
    for (const entry of fs.readdirSync(currentDirectory, {
      withFileTypes: true,
    })) {
      const fullPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        collect(fullPath);
      } else if (entry.isFile()) {
        entries.push({
          relativePath: path
            .relative(directory, fullPath)
            .split(path.sep)
            .join("/"),
          content: readTextFile(fullPath),
        });
      }
    }
  }

  collect(directory);
  return entries;
}

export function validateSymlinkWithin(
  linkPath: string,
  parentDirectory: string,
): void {
  try {
    if (!fs.lstatSync(linkPath).isSymbolicLink()) return;
    const realPath = fs.realpathSync(linkPath);
    const realParentDirectory = fs.realpathSync(parentDirectory);
    const relativePath = path.relative(realParentDirectory, realPath);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error(`Symlink ${linkPath} escapes project directory`);
    }
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export interface FileResult {
  path: string;
  created: boolean;
  overwritten: boolean;
  skipped: boolean;
  error?: string;
}

/**
 * Ensure a directory exists, creating it if necessary
 * @testonly
 */
export function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Create a file with content, optionally forcing overwrite
 */
export function createFile(
  filePath: string,
  content: string,
  options: { force?: boolean } = {},
): FileResult {
  const force = options.force ?? false;
  const exists = fs.existsSync(filePath);

  if (exists && !force) {
    return {
      path: filePath,
      created: false,
      overwritten: false,
      skipped: true,
    };
  }

  try {
    ensureDirectory(path.dirname(filePath));
    fs.writeFileSync(filePath, content, "utf-8");

    return {
      path: filePath,
      created: !exists,
      overwritten: exists,
      skipped: false,
    };
  } catch (err) {
    return {
      path: filePath,
      created: false,
      overwritten: false,
      skipped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Check if a path exists (async)
 */
export async function exists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveRealPath(filePath: string): Promise<string> {
  return fsPromises.realpath(filePath);
}

export async function isSymbolicLink(filePath: string): Promise<boolean> {
  try {
    return (await fsPromises.lstat(filePath)).isSymbolicLink();
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function readSymbolicLink(filePath: string): Promise<string> {
  return fsPromises.readlink(filePath);
}

export async function removeFile(filePath: string): Promise<void> {
  await fsPromises.unlink(filePath);
}

export function removeDirectory(directoryPath: string): void {
  fs.rmSync(directoryPath, { recursive: true, force: true });
}

/**
 * Ensure a path exists as file (with content) or directory.
 * Does NOT overwrite existing content.
 *
 * @param hostPath - Path to create
 * @param defaultContent - If provided, creates a file with this content; otherwise creates a directory
 * @returns true if path was created, false if it already existed
 *
 * @example
 * // Create directory
 * await ensurePath("/home/user/.local/state");
 *
 * // Create file with default content
 * await ensurePath("/home/user/.config.json", "{}");
 */
export async function ensurePath(
  hostPath: string,
  defaultContent?: string,
): Promise<boolean> {
  if (await exists(hostPath)) {
    return false;
  }

  if (defaultContent !== undefined) {
    await fsPromises.mkdir(path.dirname(hostPath), { recursive: true });
    await fsPromises.writeFile(hostPath, defaultContent, "utf-8");
  } else {
    await fsPromises.mkdir(hostPath, { recursive: true });
  }

  return true;
}
