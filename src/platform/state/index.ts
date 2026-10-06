import * as path from "node:path";
import { z } from "zod";
import {
  ensureDirectory,
  readJsonRecord,
  writeTextFile,
} from "#platform/filesystem/index.js";

import { getStatePath } from "./state-path.js";

export {
  claimUpdateRefresh,
  finishUpdateRefresh,
  readUpdateCache,
  startUpdateRefresh,
} from "./update-cache.js";

const stateSchema = z
  .object({
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
    sandboxStorage: z
      .record(z.string(), z.object({ id: z.string() }))
      .optional(),
  })
  .passthrough();

type State = z.infer<typeof stateSchema>;

export function readState(statePath = getStatePath()): State {
  const result = stateSchema.safeParse(readJsonRecord(statePath));
  return result.success ? result.data : {};
}

export function writeState(
  updates: Partial<State>,
  statePath = getStatePath(),
): void {
  const state = stateSchema.parse({ ...readState(statePath), ...updates });
  ensureDirectory(path.dirname(statePath));
  writeTextFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}
