import * as path from "node:path";
import chalk from "chalk";
import { z } from "zod";
import {
  ensureDirectory,
  readJsonRecord,
  writeTextFileAtomically,
} from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";

import { getStatePath } from "./state-path.js";

export {
  claimUpdateRefresh,
  finishUpdateRefresh,
  readUpdateCache,
  startUpdateRefresh,
} from "./update-cache.js";

const stateSchema = z.looseObject({
  latestVersion: z.string().optional(),
  latestVersionCheckedAt: z.number().optional(),
  templateHashes: z.record(z.string(), z.string()).optional(),
  sandboxImages: z
    .record(
      z.string(),
      z.object({
        reference: z.string(),
        digest: z.string(),
        labels: z.record(z.string(), z.string()).optional(),
        ownedDigests: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  sandboxStorage: z.record(z.string(), z.object({ id: z.string() })).optional(),
});

type State = z.infer<typeof stateSchema>;

function dropInvalidFields(
  record: Record<string, unknown>,
  error: z.ZodError,
): Record<string, unknown> {
  const invalidKeys = new Set(
    error.issues.map((issue) => String(issue.path[0])),
  );
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !invalidKeys.has(key)),
  );
}

export function readState(statePath = getStatePath()): State {
  const record = readJsonRecord(statePath);
  const result = stateSchema.safeParse(record);
  if (result.success) return result.data;
  const sanitized = dropInvalidFields(record, result.error);
  const invalidKeys = Object.keys(record).filter((key) => !(key in sanitized));
  getLogger().warn(
    `Ignoring invalid state fields in ${chalk.dim(statePath)}: ${invalidKeys.join(", ")}`,
  );
  const retry = stateSchema.safeParse(sanitized);
  return retry.success ? retry.data : {};
}

export function writeState(
  updates: Partial<State>,
  statePath = getStatePath(),
): void {
  const state = stateSchema.parse({ ...readState(statePath), ...updates });
  ensureDirectory(path.dirname(statePath));
  writeTextFileAtomically(statePath, `${JSON.stringify(state, null, 2)}\n`);
}
