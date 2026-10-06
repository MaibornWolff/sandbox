import {
  chmod,
  lchown,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { removeOwnedDirectory } from "#platform/filesystem/index.js";
import { getRepoRootPath } from "../../../src/platform/git/index.js";
import { log } from "./log.js";
import type { SandboxInstance } from "./sandbox.js";

async function getTempBase(): Promise<string> {
  if (process.env.SANDBOX_TEST_TMP) {
    return process.env.SANDBOX_TEST_TMP;
  }

  const repoRoot = await getRepoRootPath(process.cwd());
  return join(repoRoot, "test-tmp", "e2e");
}

function getConfiguredProjectOwner(): { uid: number; gid: number } | undefined {
  const uidValue = process.env.SANDBOX_HOST_UID;
  const gidValue = process.env.SANDBOX_HOST_GID;
  if (uidValue === undefined && gidValue === undefined) return undefined;
  if (!/^\d+$/.test(uidValue ?? "") || !/^\d+$/.test(gidValue ?? "")) {
    throw new Error(
      "SANDBOX_HOST_UID and SANDBOX_HOST_GID must both be non-negative integers for E2E tests",
    );
  }
  return { uid: Number(uidValue), gid: Number(gidValue) };
}

export async function assignConfiguredHostOwnership(
  path: string,
): Promise<void> {
  const owner = getConfiguredProjectOwner();
  if (!owner) return;

  await assignOwnershipRecursively(path, owner);
}

async function assignOwnershipRecursively(
  path: string,
  owner: { uid: number; gid: number },
): Promise<void> {
  let pathInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    pathInfo = await lstat(path);
  } catch (error) {
    throw new Error(
      `Failed to inspect E2E fixture path ${path} for ownership repair`,
      {
        cause: error,
      },
    );
  }

  if (pathInfo.isDirectory()) {
    let entries: string[];
    try {
      entries = await readdir(path);
    } catch (error) {
      throw new Error(
        `Failed to read E2E fixture path ${path} for ownership repair`,
        {
          cause: error,
        },
      );
    }

    for (const entry of entries) {
      await assignOwnershipRecursively(join(path, entry), owner);
    }
  }

  await assignPathOwnership(path, owner);
}

async function assignPathOwnership(
  path: string,
  owner: { uid: number; gid: number },
): Promise<void> {
  try {
    await lchown(path, owner.uid, owner.gid);
  } catch (error) {
    throw new Error(
      `Failed to assign E2E fixture path ${path} to configured host owner uid ${owner.uid}, gid ${owner.gid}`,
      { cause: error },
    );
  }
}

export async function createTempProject(name: string): Promise<string> {
  const tempBase = await getTempBase();
  await mkdir(tempBase, { recursive: true });
  const dir = await mkdtemp(join(tempBase, `${name}-`));
  const configDir = join(dir, ".sandbox");
  await mkdir(configDir);
  await Promise.all([chmod(dir, 0o755), chmod(configDir, 0o755)]);
  await assignConfiguredHostOwnership(dir);
  return dir;
}

export async function writeProjectFile(
  dir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = join(dir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

/**
 * Stop containers and remove the temp directory.
 * Keeps the Docker image so subsequent runs benefit from layer cache.
 */
export async function cleanupProject(
  dir: string,
  sb: SandboxInstance | undefined,
): Promise<void> {
  log("→ Stopping containers...");
  if (sb) {
    try {
      await sb.stop();
    } catch {
      /* best effort */
    }
  }
  removeOwnedDirectory(dir);
  log("→ Cleanup complete");
}
