import * as crypto from "node:crypto";
import { readState, writeState } from "#platform/state/index.js";
import {
  type FileDefinition,
  getUserFileDefinitions,
  type TemplateChoices,
} from "./generated-file-definition.js";

interface TemplateHashes {
  [fileId: string]: string;
}

/** @testonly */
export function computeTemplateHashesForDefinitions(
  definitions: readonly FileDefinition[],
  choices: TemplateChoices,
): TemplateHashes {
  const hashes: TemplateHashes = {};
  for (const definition of definitions) {
    const content = definition.getTemplate(choices);
    hashes[definition.id] = crypto
      .createHash("sha256")
      .update(content)
      .digest("hex");
  }
  return hashes;
}

export function computeTemplateHashes(
  choices: TemplateChoices,
): TemplateHashes {
  return computeTemplateHashesForDefinitions(getUserFileDefinitions(), choices);
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

export function haveTemplatesChanged(choices: TemplateChoices): boolean {
  return templateHashesDiffer(
    loadStoredTemplateHashes(),
    computeTemplateHashes(choices),
  );
}
