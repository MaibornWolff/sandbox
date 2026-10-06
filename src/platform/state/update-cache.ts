import * as path from "node:path";
import { z } from "zod";
import {
  ensureDirectory,
  listDirectory,
  pathExists,
  readJsonRecord,
  removePath,
  renamePath,
  tryCreateDirectory,
  writeTextFile,
} from "#platform/filesystem/index.js";

import { getStatePath } from "./state-path.js";

const RETRY_INTERVAL = 60 * 60 * 1_000;
const CACHE_INTERVAL = 24 * RETRY_INTERVAL;
const cacheSchema = z.object({
  latestVersion: z.string().optional(),
  checkedAt: z.number().finite().optional(),
  error: z.string().optional(),
});
type UpdateCache = z.infer<typeof cacheSchema>;

function cacheDirectory(): string {
  return path.join(path.dirname(getStatePath()), "update-check");
}

function attemptDirectory(attempt: number): string {
  return path.join(cacheDirectory(), `attempt-${attempt}`);
}

export function readUpdateCache(): UpdateCache {
  const cachePath = path.join(cacheDirectory(), "cache.json");
  const legacy = pathExists(cachePath) ? {} : readJsonRecord(getStatePath());
  const parsed = cacheSchema.safeParse(
    pathExists(cachePath)
      ? readJsonRecord(cachePath)
      : {
          latestVersion: legacy.latestVersion,
          checkedAt: legacy.latestVersionCheckedAt,
        },
  );
  return parsed.success ? parsed.data : {};
}

export function claimUpdateRefresh(now: number): string | undefined {
  const cache = readUpdateCache();
  if (cache.checkedAt !== undefined && now - cache.checkedAt < CACHE_INTERVAL)
    return undefined;
  const attempt = Math.floor(now / RETRY_INTERVAL);
  ensureDirectory(cacheDirectory());
  // Keep the previous slot to guarantee at least one hour between attempts.
  if (pathExists(attemptDirectory(attempt - 1))) return undefined;
  if (!tryCreateDirectory(attemptDirectory(attempt))) return undefined;
  for (const entry of listDirectory(cacheDirectory())) {
    const match = /^attempt-(\d+)$/.exec(entry);
    if (match && Number(match[1]) < attempt - 1) {
      removePath(path.join(cacheDirectory(), entry));
    }
  }
  return String(attempt);
}

function validAttempt(token: string, now: number): number | undefined {
  if (!/^\d+$/.test(token)) return undefined;
  const attempt = Number(token);
  const current = Math.floor(now / RETRY_INTERVAL);
  return Number.isSafeInteger(attempt) &&
    attempt <= current &&
    attempt >= current - 1
    ? attempt
    : undefined;
}

export function startUpdateRefresh(token: string, now: number): boolean {
  const attempt = validAttempt(token, now);
  return (
    attempt !== undefined &&
    pathExists(attemptDirectory(attempt)) &&
    tryCreateDirectory(path.join(attemptDirectory(attempt), "running"))
  );
}

export function finishUpdateRefresh(
  token: string,
  now: number,
  result: { readonly latestVersion: string } | { readonly error: string },
): void {
  const attempt = validAttempt(token, now);
  if (attempt === undefined || !pathExists(attemptDirectory(attempt))) return;
  const previous = readUpdateCache();
  const cache: UpdateCache =
    "latestVersion" in result
      ? { latestVersion: result.latestVersion, checkedAt: now }
      : { ...previous, error: result.error.slice(0, 500) };
  const temporary = path.join(attemptDirectory(attempt), "result.json");
  writeTextFile(temporary, `${JSON.stringify(cache)}\n`);
  renamePath(temporary, path.join(cacheDirectory(), "cache.json"));
}
