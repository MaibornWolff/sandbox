import * as crypto from "node:crypto";
import { readState, writeState } from "#platform/state/index.js";
import {
  type FileDefinition,
  getUserFileDefinitions,
} from "./generated-file-definition.js";

interface TemplateHashes {
  [fileId: string]: string;
}

/** @testonly */
export function computeTemplateHashesForDefinitions(
  definitions: readonly FileDefinition[],
  toolIds: readonly string[],
): TemplateHashes {
  const hashes: TemplateHashes = {};
  for (const definition of definitions) {
    const content = definition.getTemplate([...toolIds]);
    hashes[definition.id] = crypto
      .createHash("sha256")
      .update(content)
      .digest("hex");
  }
  return hashes;
}

export function computeTemplateHashes(toolIds: string[]): TemplateHashes {
  return computeTemplateHashesForDefinitions(getUserFileDefinitions(), toolIds);
}

/** @lintignore Owner-local persisted hash reader covered by focused tests. */
export function loadStoredTemplateHashes(): TemplateHashes | null {
  const hashes = readState().templateHashes;
  if (hashes == null || typeof hashes !== "object" || Array.isArray(hashes)) {
    return null;
  }
  return hashes as TemplateHashes;
}

export function saveTemplateHashes(hashes: TemplateHashes): void {
  writeState({ templateHashes: hashes });
}

/** @testonly */
export function templateHashesDiffer(
  stored: TemplateHashes | null,
  current: TemplateHashes,
): boolean {
  if (stored === null) return true;
  for (const key of Object.keys(current)) {
    if (stored[key] !== current[key]) return true;
  }
  for (const key of Object.keys(stored)) {
    if (!(key in current)) return true;
  }
  return false;
}

export function haveTemplatesChanged(toolIds: string[]): boolean {
  return templateHashesDiffer(
    loadStoredTemplateHashes(),
    computeTemplateHashes(toolIds),
  );
}
