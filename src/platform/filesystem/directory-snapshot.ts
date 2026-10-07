import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { listFilesRecursively } from "./file.js";

type DirectoryEntry = ReturnType<typeof listFilesRecursively>[number];

function compareEntries(left: DirectoryEntry, right: DirectoryEntry): number {
  if (left.relativePath < right.relativePath) return -1;
  return left.relativePath > right.relativePath ? 1 : 0;
}

function getNormalizedMode(directory: string, entry: DirectoryEntry): number {
  const content = Buffer.from(entry.content);
  const executable =
    (statSync(path.join(directory, entry.relativePath)).mode & 0o111) !== 0 ||
    content.subarray(0, 2).toString() === "#!";
  return executable ? 0o555 : 0o444;
}

export function hashDirectoryContents(directory: string): string {
  const hash = createHash("sha256");
  for (const entry of listFilesRecursively(directory).sort(compareEntries)) {
    if (entry.kind !== "file") {
      throw new Error(
        `Directory hashing requires regular files: ${entry.relativePath}`,
      );
    }
    const header = JSON.stringify({
      path: entry.relativePath,
      size: entry.content.byteLength,
      mode: getNormalizedMode(directory, entry),
    });
    hash.update(header).update("\0").update(entry.content).update("\0");
  }
  return hash.digest("hex");
}
