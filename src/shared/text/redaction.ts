/**
 * Centralized redaction utility for sensitive data in logs and output.
 * Handles command display, argv redaction, and environment variable display.
 */

import { shellQuote } from "./shell-quote.js";

const REDACTED = "<redacted>";
const MIN_KNOWN_SECRET_LENGTH = 3;

/**
 * Patterns that indicate a key contains sensitive data.
 * Case-insensitive matching for comprehensive coverage.
 */
const SECRET_PATTERNS = [
  /key/i,
  /token/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /api/i,
  /auth/i,
  /credential/i,
  /session/i,
  /cookie/i,
];

const SENSITIVE_ASSIGNMENT_OPTIONS = ["-e", "--env", "--build-arg"];
const SENSITIVE_INLINE_PREFIXES = ["--env=", "--build-arg="];

interface RedactionContextOptions {
  args?: string[];
  env?: Record<string, string>;
}

interface RedactionContext {
  redactText(text: string): string;
}

/**
 * Check if an environment variable key likely contains sensitive data.
 *
 * @param key - Environment variable name to check
 * @returns true if the key matches any secret pattern
 * @testonly
 */
export function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Format a command and argv for safe display.
 * Redaction happens before shell quoting so raw secrets are never rendered.
 */
export function redactCommandForDisplay(
  command: string,
  args: string[] = [],
): string {
  const displayArgs = redactCommandArgs(args).map(shellQuote).join(" ");
  return displayArgs ? `${command} ${displayArgs}` : command;
}

/**
 * Legacy string-based Docker command redaction.
 * Prefer redactCommandForDisplay(command, args) for argv-based command display.
 */
/** @testonly */
export function redactDockerCommand(command: string): string {
  const parts = command.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return command;
  const [binary, ...args] = parts;
  if (!binary) return command;
  return redactCommandForDisplay(binary, args);
}

/**
 * Redact sensitive assignments in an argv-style command array.
 *
 * Handles `-e KEY=VALUE`, `--env KEY=VALUE`, `--build-arg KEY=VALUE`,
 * `--env=KEY=VALUE`, and `--build-arg=KEY=VALUE`.
 */
/** @testonly */
export function redactCommandArgs(args: string[]): string[] {
  const redacted = [...args];

  for (let i = 0; i < redacted.length; i++) {
    const arg = redacted[i];
    if (!arg) continue;

    if (SENSITIVE_ASSIGNMENT_OPTIONS.includes(arg)) {
      const next = redacted[i + 1];
      if (!next) continue;
      redacted[i + 1] = redactAssignmentForDisplay(next);
      i++;
      continue;
    }

    const inlinePrefix = SENSITIVE_INLINE_PREFIXES.find((prefix) =>
      arg.startsWith(prefix),
    );
    if (inlinePrefix) {
      const assignment = arg.slice(inlinePrefix.length);
      redacted[i] = `${inlinePrefix}${redactAssignmentForDisplay(assignment)}`;
    }
  }

  return redacted;
}

/**
 * Create a context that redacts known secret values from arbitrary text.
 * This intentionally only uses values explicitly known from command args and
 * ExecOptions.env instead of scanning process.env.
 */
export function createRedactionContext(
  options: RedactionContextOptions = {},
): RedactionContext {
  const secretValues = collectKnownSecretValues(options);

  return {
    redactText(text: string): string {
      let redactedText = text;
      for (const value of secretValues) {
        redactedText = redactedText.split(value).join(REDACTED);
      }
      return redactedText;
    },
  };
}

/**
 * Redact environment variable value for display.
 * Secret-key values are fully masked to avoid prefix leakage.
 */
export function redactEnvValue(key: string, value: string): string {
  if (!isSecretKey(key)) {
    return maskUrlCredentials(value);
  }

  return REDACTED;
}

function redactAssignmentForDisplay(assignment: string): string {
  const parsed = parseAssignment(assignment);
  if (!parsed) {
    return assignment;
  }

  if (isSecretKey(parsed.key)) {
    return `${parsed.key}=${REDACTED}`;
  }

  return `${parsed.key}=${maskUrlCredentials(parsed.value)}`;
}

function parseAssignment(
  assignment: string,
): { key: string; value: string } | undefined {
  const equalsIndex = assignment.indexOf("=");
  if (equalsIndex === -1) {
    return undefined;
  }

  return {
    key: assignment.slice(0, equalsIndex),
    value: assignment.slice(equalsIndex + 1),
  };
}

function collectKnownSecretValues(options: RedactionContextOptions): string[] {
  const values = new Set<string>();

  for (const value of collectSensitiveAssignmentValues(options.args ?? [])) {
    addKnownSecretValue(values, value);
    for (const credential of collectUrlCredentialValues(value)) {
      addKnownSecretValue(values, credential);
    }
  }

  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (isSecretKey(key)) {
      addKnownSecretValue(values, value);
    }
    for (const credential of collectUrlCredentialValues(value)) {
      addKnownSecretValue(values, credential);
    }
  }

  return [...values].sort((a, b) => b.length - a.length);
}

function collectSensitiveAssignmentValues(args: string[]): string[] {
  const values: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (SENSITIVE_ASSIGNMENT_OPTIONS.includes(arg)) {
      const assignment = args[i + 1];
      if (assignment) collectSensitiveAssignmentValue(assignment, values);
      i++;
      continue;
    }

    const inlinePrefix = SENSITIVE_INLINE_PREFIXES.find((prefix) =>
      arg.startsWith(prefix),
    );
    if (inlinePrefix) {
      collectSensitiveAssignmentValue(arg.slice(inlinePrefix.length), values);
    }
  }

  return values;
}

function collectSensitiveAssignmentValue(
  assignment: string,
  values: string[],
): void {
  const parsed = parseAssignment(assignment);
  if (!parsed) return;

  if (isSecretKey(parsed.key)) {
    values.push(parsed.value);
  }

  for (const credential of collectUrlCredentialValues(parsed.value)) {
    values.push(credential);
  }
}

function addKnownSecretValue(values: Set<string>, value: string): void {
  if (value.length >= MIN_KNOWN_SECRET_LENGTH) {
    values.add(value);
  }
}

function maskUrlCredentials(value: string): string {
  const match = value.match(/^([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@(.+)$/i);
  if (!match) {
    return value;
  }

  const [, protocol = "", credentials = "", rest = ""] = match;
  if (credentials.includes(":")) {
    const username = credentials.slice(0, credentials.indexOf(":"));
    return `${protocol}${username}:${REDACTED}@${rest}`;
  }

  return `${protocol}${REDACTED}@${rest}`;
}

function collectUrlCredentialValues(value: string): string[] {
  const match = value.match(/^[a-z][a-z0-9+.-]*:\/\/([^\s/@]+)@.+$/i);
  if (!match) {
    return [];
  }

  const credentials = match[1] ?? "";
  if (!credentials.includes(":")) {
    return [credentials];
  }

  const password = credentials.slice(credentials.indexOf(":") + 1);
  return password ? [password, credentials] : [credentials];
}
