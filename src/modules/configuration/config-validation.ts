import { hasNormalizedPathSegments } from "#shared/text/index.js";
import type { PersistPathInput, SettingsEntryInput } from "./config.js";
import { normalizePersistPath, type TomlConfig } from "./toml-config-schema.js";

interface ValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
  suggestRegenerate: boolean;
}

function validateNamedVolumePath(
  input: PersistPathInput,
  p: string,
): string | null {
  if (input.default !== undefined) {
    return `use_named_volume cannot be combined with default. Path: "${p}"`;
  }
  if (input.only_if_exists) {
    return `use_named_volume cannot be combined with only_if_exists. Path: "${p}"`;
  }
  if (hasGlobChars(p)) {
    return `use_named_volume cannot be combined with glob paths. Path: "${p}"`;
  }
  if (!p.startsWith("/") && !p.startsWith("~/")) {
    return `use_named_volume requires an absolute or home-relative (~/...) container path. Path: "${p}"`;
  }
  return null;
}

function validateBindMountPath(global: boolean, p: string): string | null {
  if (!p.startsWith("/") && !p.startsWith("./") && !p.startsWith("~")) {
    return `Invalid path format: "${p}". Must start with "/" (absolute), "./" (project-relative), or "~/" (home-relative).`;
  }
  if (global && p.startsWith("./")) {
    return `Invalid global path: "${p}". Global paths cannot use project-relative format (./). Use ~/ or / instead.`;
  }
  if (global && hasGlobChars(p)) {
    return `Glob patterns cannot be used with global: true. Path: "${p}"`;
  }
  if (hasGlobChars(p) && !p.startsWith("./")) {
    return `Glob patterns are only supported for project-relative paths (./). Path: "${p}"`;
  }
  return null;
}

/**
 * Validate a persist_path format.
 * Valid formats:
 *   - ~/foo or ~  → Home-relative (expands to /home/sandbox/foo)
 *   - ./foo       → Project-relative (relative to workdir)
 *   - /foo        → Absolute container path
 * Invalid formats: bare paths without prefix (e.g., "node_modules")
 *
 * Additional validation:
 *   - global: true requires ~/ or / prefix (not ./)
 *   - Glob patterns cannot be used with global: true
 *   - Glob patterns only supported for project-relative paths (./)
 *   - use_named_volume requires an absolute or home-relative (~/...) path
 * @testonly
 */
export function validatePersistPath(input: PersistPathInput): string | null {
  const normalized = normalizePersistPath(input);
  const p = normalized.path;
  if (normalized.useNamedVolume !== undefined) {
    return validateNamedVolumePath(input, p);
  }
  return validateBindMountPath(normalized.global, p);
}

/**
 * Check if a path uses glob patterns
 */
export function hasGlobChars(p: string): boolean {
  return /[*?[\]{}]/.test(p);
}

/**
 * Validate a settings pattern format.
 * Valid formats:
 *   - ~/foo or ~/.foo  → Home-relative pattern
 *   - !~/foo           → Exclusion pattern (home-relative)
 * Invalid formats: patterns without ~/ prefix
 * @testonly
 */
export function validateSettingsPattern(pattern: string): string | null {
  if (pattern.startsWith("!")) {
    const rest = pattern.slice(1);
    if (!rest.startsWith("~/")) {
      return `Invalid exclusion pattern: "${pattern}". Must start with "!~/" (e.g., "!~/node_modules").`;
    }
    return null;
  }

  if (!pattern.startsWith("~/")) {
    return `Invalid settings pattern: "${pattern}". Must start with "~/" (e.g., "~/.claude/skills/").`;
  }

  return null;
}

function isNormalizedSettingsPath(path: string): boolean {
  const relativePath = path.startsWith("!~/") ? path.slice(3) : path.slice(2);
  return hasNormalizedPathSegments(relativePath);
}

const CONTAINER_HOME_PREFIX = "/home/sandbox/";

/**
 * Strip the persist path prefix (~/, ./, /home/sandbox/, or /) and return
 * the remainder that selects a location below that prefix.
 */
function getPersistPathRemainder(p: string): string {
  if (p.startsWith("~/") || p.startsWith("./")) return p.slice(2);
  if (p.startsWith(CONTAINER_HOME_PREFIX)) {
    return p.slice(CONTAINER_HOME_PREFIX.length);
  }
  if (p.startsWith("/")) return p.slice(1);
  return p;
}

/**
 * Reject persist paths whose segments could leave the persist storage
 * directory on the host, or select that directory itself, once they are
 * joined onto it.
 */
function validatePersistPathSegments(p: string): string | null {
  if (hasNormalizedPathSegments(getPersistPathRemainder(p))) return null;
  return `Invalid persist path: "${p}". Use a path below the prefix without '.', '..', repeated separators, or backslashes.`;
}

function addError(result: ValidationResult, error: string): void {
  result.errors.push(error);
  result.valid = false;
  result.suggestRegenerate = true;
}

function validateSettingsEntry(input: SettingsEntryInput): string | null {
  const path = typeof input === "string" ? input : input.path;
  const mode = typeof input === "string" ? "mount" : (input.mode ?? "mount");
  const pathError = validateSettingsPattern(path);
  if (pathError) return pathError;
  if (!isNormalizedSettingsPath(path)) {
    return `Invalid settings path: "${path}". Use a normalized home-relative path without '.', '..', repeated separators, or backslashes.`;
  }
  if (mode === "copy" && path.startsWith("!")) {
    return `Copy setting path must not be an exclusion: "${path}".`;
  }
  if (mode === "copy" && hasGlobChars(path)) {
    return `Copy setting path must be literal and cannot contain a glob: "${path}".`;
  }
  return null;
}

function validatePersistPaths(
  paths: PersistPathInput[],
  result: ValidationResult,
): void {
  const seenNamedVolumes = new Set<string>();
  for (const p of paths) {
    const segmentError = validatePersistPathSegments(p.path);
    if (segmentError) {
      addError(result, segmentError);
      continue;
    }
    const error = validatePersistPath(p);
    if (error) {
      result.warnings.push(error);
      result.suggestRegenerate = true;
    }
    if (hasGlobChars(p.path) && p.only_if_exists === false) {
      result.warnings.push(
        `only_if_exists: false has no effect on glob patterns (globs only match existing paths): "${p.path}"`,
      );
    }
    if (p.use_named_volume !== undefined) {
      if (seenNamedVolumes.has(p.use_named_volume)) {
        result.warnings.push(
          `Duplicate use_named_volume value: "${p.use_named_volume}"`,
        );
        result.suggestRegenerate = true;
      } else {
        seenNamedVolumes.add(p.use_named_volume);
      }
    }
  }
}

/**
 * Validate config and detect deprecated patterns
 */
export function validateConfig(config: TomlConfig): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    warnings: [],
    errors: [],
    suggestRegenerate: false,
  };

  validatePersistPaths(config.persist_paths ?? [], result);

  for (const entry of config.settings ?? []) {
    const error = validateSettingsEntry(entry);
    if (error) addError(result, error);
  }

  return result;
}
