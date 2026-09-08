import * as crypto from "node:crypto";
import * as path from "node:path";
import { listFilesRecursively } from "#platform/filesystem/index.js";

/** @lintignore Testable deterministic build-context hash primitive. */
export function hashBuildContextEntries(
  entries: readonly {
    relativePath: string;
    kind: "file" | "symbolic-link";
    content: Uint8Array | string;
  }[],
): string {
  const hash = crypto.createHash("sha256");
  const normalizedEntries = entries
    .map((entry) => ({
      relativePath: entry.relativePath.replaceAll("\\", "/"),
      kind: entry.kind,
      content: entry.content,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  for (const entry of normalizedEntries) {
    hash.update(entry.relativePath);
    hash.update("\0");
    hash.update(entry.kind);
    hash.update("\0");
    hash.update(entry.content);
    hash.update("\0");
  }

  return hash.digest("hex").substring(0, 12);
}

export function getImageHash(dockerfilePath: string): string {
  return hashBuildContextEntries(
    listFilesRecursively(path.dirname(dockerfilePath)),
  );
}
