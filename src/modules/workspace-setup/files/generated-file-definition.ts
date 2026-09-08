import {
  getGlobalConfigPath,
  getGlobalDockerfilePath,
  getProjectConfigPath,
  getProjectDockerfilePath,
  injectAllowedDomains,
  type PersistPathInput,
} from "#modules/configuration/index.js";
import { BASE_IMAGE, USER_IMAGE } from "#modules/sandbox-resources/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { pathExists } from "#platform/filesystem/index.js";
import {
  readToolIdsFromDockerfile,
  validateToolIds,
} from "../initialization/build-context-detection.js";
import { generateDockerfile } from "../tools/dockerfile-generation.js";
import { resolveTools } from "../tools/tool-resolution.js";
import { injectNamedVolumePersistPaths } from "./config-template-writing.js";
import {
  CONFIG_TOML_TEMPLATE,
  PROJECT_CONFIG_TOML_TEMPLATE,
} from "./template-loading.js";

export interface FileDefinition {
  id: string;
  name: string;
  description?: string;
  getPath: () => string;
  getTemplate: (toolIds: string[]) => string;
}

/**
 * Collect all network domains from selected tools that declare allowNetwork.
 */
function collectNetworkDomains(toolIds: string[]): string[] {
  return resolveTools(toolIds).dependencyClosure.flatMap(
    (tool) => tool.allowNetwork ?? [],
  );
}

function collectToolPersistPaths(toolIds: string[]): PersistPathInput[] {
  return resolveTools(toolIds).dependencyClosure.flatMap(
    (tool) => tool.persistPaths ?? [],
  );
}

/**
 * User-level file definitions (used by init and config-update).
 */
export function getUserFileDefinitions(): FileDefinition[] {
  return [
    {
      id: "config",
      name: "config.toml",
      description: "Global configuration",
      getPath: getGlobalConfigPath,
      getTemplate: (toolIds) => {
        const domains = collectNetworkDomains(toolIds);
        return injectAllowedDomains(CONFIG_TOML_TEMPLATE, domains);
      },
    },
    {
      id: "dockerfile",
      name: "docker/Dockerfile",
      description: "User-level image template",
      getPath: getGlobalDockerfilePath,
      getTemplate: (toolIds) => {
        const resolved = resolveTools(toolIds);
        return generateDockerfile({
          tools: resolved.dependencyClosure,
          baseImage: BASE_IMAGE,
          toolIds: resolved.directSelections.map((tool) => tool.id),
        });
      },
    },
  ];
}

/**
 * Find the Dockerfile path from a set of file definitions.
 * Returns null if no dockerfile definition exists.
 * @testonly
 */
export function getDockerfilePath(
  definitions: FileDefinition[],
): string | null {
  const def = definitions.find((d) => d.id === "dockerfile");
  return def ? def.getPath() : null;
}

/**
 * Check if any file from the definitions already exists on disk.
 */
export function hasExistingConfig(definitions: FileDefinition[]): boolean {
  return definitions.some((def) => pathExists(def.getPath()));
}

/**
 * Detect and validate tool IDs from the Dockerfile referenced in definitions.
 * Provides all info callers need to decide how to handle missing/present tools:
 * - config-update: if !hasToolComment && hasDockerfile -> prompt interactively
 * - init: use toolIds as pre-selection for selectTools (always prompts)
 * - update: just use toolIds directly (never prompts)
 */
export function detectExistingTools(definitions: FileDefinition[]): {
  toolIds: string[];
  unknown: string[];
  hasDockerfile: boolean;
  hasToolComment: boolean;
} {
  const dockerfilePath = getDockerfilePath(definitions);
  if (!dockerfilePath || !pathExists(dockerfilePath)) {
    return {
      toolIds: [],
      unknown: [],
      hasDockerfile: false,
      hasToolComment: false,
    };
  }
  const raw = readToolIdsFromDockerfile(dockerfilePath);
  if (raw === null) {
    return {
      toolIds: [],
      unknown: [],
      hasDockerfile: true,
      hasToolComment: false,
    };
  }
  const { valid, unknown } = validateToolIds(raw);
  return { toolIds: valid, unknown, hasDockerfile: true, hasToolComment: true };
}

/**
 * Project-level file definitions (used by init --project).
 */
function getProjectBaseImage(): string {
  const userDockerfilePath = getGlobalDockerfilePath();
  return pathExists(userDockerfilePath) ? USER_IMAGE : BASE_IMAGE;
}

export function getProjectFileDefinitions(): FileDefinition[] {
  return [
    {
      id: "config",
      name: "config.toml",
      description: "Project configuration",
      getPath: () =>
        getProjectConfigPath(getHostEnvironment().currentWorkingDirectory),
      getTemplate: (toolIds) => {
        const domains = collectNetworkDomains(toolIds);
        const toolPaths = collectToolPersistPaths(toolIds);
        const content = injectAllowedDomains(
          PROJECT_CONFIG_TOML_TEMPLATE,
          domains,
        );
        return injectNamedVolumePersistPaths(content, toolPaths);
      },
    },
    {
      id: "dockerfile",
      name: "docker/Dockerfile",
      description: "Project-specific image",
      getPath: () =>
        getProjectDockerfilePath(getHostEnvironment().currentWorkingDirectory),
      getTemplate: (toolIds) => {
        const resolved = resolveTools(toolIds);
        return generateDockerfile({
          tools: resolved.dependencyClosure,
          baseImage: getProjectBaseImage(),
          toolIds: resolved.directSelections.map((tool) => tool.id),
        });
      },
    },
  ];
}
