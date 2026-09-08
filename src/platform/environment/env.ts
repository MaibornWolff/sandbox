/**
 * Environment variable expansion utilities
 *
 * Provides functions to expand $VAR and ${VAR} syntax in environment variable values.
 */

import { getLogger } from "#platform/logging/index.js";

/**
 * Expand environment variables in a value string.
 * Supports $VAR and ${VAR} syntax.
 * Use \$ to escape (produces literal $).
 *
 * @param value - The value string potentially containing variable references
 * @param definedVars - Record of already-defined variables to use for expansion
 * @param onUndefined - Optional callback invoked for each undefined variable
 * @returns The value with all variables expanded
 *
 * @example
 * expandEnvValue("$HOME/data", {}, undefined, variables)
 * expandEnvValue("${HOME}/data", {}, undefined, variables)
 * expandEnvValue("$A/$B", { A: "x" })        // "x/" (B undefined → empty + callback)
 * expandEnvValue("\\$HOME/data", {})         // "$HOME/data" (escaped)
 * expandEnvValue("cost: \\$100", {})         // "cost: $100"
 * @testonly
 */
export function expandEnvValue(
  value: string,
  definedVars: Record<string, string>,
  onUndefined?: (varName: string) => void,
  variables: Readonly<Record<string, string>> = {},
): string {
  let result = "";
  let i = 0;

  while (i < value.length) {
    const char = value[i];

    // Handle escape sequence: \$ -> $
    if (char === "\\" && i + 1 < value.length && value[i + 1] === "$") {
      result += "$";
      i += 2;
      continue;
    }

    // Handle variable reference: $VAR or ${VAR}
    if (char === "$") {
      const expansion = parseVariableReference(value, i);

      if (expansion) {
        const { varName, endIndex } = expansion;
        const varValue = lookupVariable(
          varName,
          definedVars,
          variables,
          onUndefined,
        );
        result += varValue;
        i = endIndex;
        continue;
      }
    }

    // Regular character
    result += char;
    i++;
  }

  return result;
}

/**
 * Parse a variable reference starting at position i
 * Returns the variable name and the index after the reference, or null if not a valid reference
 */
function parseVariableReference(
  value: string,
  startIndex: number,
): { varName: string; endIndex: number } | null {
  // Must start with $
  if (value[startIndex] !== "$") {
    return null;
  }

  const nextChar = value[startIndex + 1];

  // ${VAR} syntax
  if (nextChar === "{") {
    const closeBrace = value.indexOf("}", startIndex + 2);
    if (closeBrace === -1) {
      // No closing brace - not a valid reference, treat as literal
      return null;
    }
    const varName = value.slice(startIndex + 2, closeBrace);
    if (!isValidVarName(varName)) {
      return null;
    }
    return { varName, endIndex: closeBrace + 1 };
  }

  // $VAR syntax - read until non-identifier character
  if (isVarNameStart(nextChar)) {
    let endIndex = startIndex + 2;
    while (endIndex < value.length) {
      const char = value[endIndex];
      if (char === undefined || !isVarNameChar(char)) break;
      endIndex++;
    }
    const varName = value.slice(startIndex + 1, endIndex);
    return { varName, endIndex };
  }

  // Not a valid variable reference (e.g., "$", "$ ", "$1abc")
  return null;
}

/**
 * Check if a character can start a variable name (letter or underscore)
 */
function isVarNameStart(char: string | undefined): boolean {
  if (!char) return false;
  return /^[a-zA-Z_]$/.test(char);
}

/**
 * Check if a character can be part of a variable name (letter, digit, or underscore)
 */
function isVarNameChar(char: string): boolean {
  return /^[a-zA-Z0-9_]$/.test(char);
}

/**
 * Check if a string is a valid variable name
 */
function isValidVarName(name: string): boolean {
  if (name.length === 0) return false;
  const firstChar = name[0];
  if (firstChar === undefined || !isVarNameStart(firstChar)) return false;
  for (let i = 1; i < name.length; i++) {
    const char = name[i];
    if (char === undefined || !isVarNameChar(char)) return false;
  }
  return true;
}

/**
 * Look up a variable value from definedVars or the host snapshot
 * Calls onUndefined callback if the variable is not found
 */
function lookupVariable(
  varName: string,
  definedVars: Record<string, string>,
  variables: Readonly<Record<string, string>>,
  onUndefined?: (varName: string) => void,
): string {
  // First check previously defined vars (takes precedence)
  const definedValue = definedVars[varName];
  if (definedValue !== undefined) {
    return definedValue;
  }

  // Then check the immutable host environment snapshot.
  const envValue = variables[varName];
  if (envValue !== undefined) {
    return envValue;
  }

  // Variable not found
  if (onUndefined) {
    onUndefined(varName);
  }
  return "";
}

/**
 * Parse an environment variable string with variable expansion.
 *
 * Handles both explicit values (FOO=bar) and passthrough (FOO).
 * For explicit values, expands $VAR and ${VAR} references.
 *
 * @param value - The env string (e.g., "FOO=$BAR" or "FOO" for passthrough)
 * @param previousEnvs - Array of previously defined env vars in "KEY=value" format
 * @param onUndefined - Optional callback for undefined variable warnings
 * @returns The parsed env string with expansions, or undefined if passthrough var is not set
 *
 * @example
 * parseEnvWithExpansion("FOO=$BAR", ["BAR=hello"], onWarn)  // "FOO=hello"
 * parseEnvWithExpansion("API", [], onWarn, variables)       // "API=<snapshot value>" or undefined
 * parseEnvWithExpansion("PATH=$HOME/bin:$PATH", [], onWarn) // Expands both vars
 * @testonly
 */
export function parseEnvWithExpansion(
  value: string,
  previousEnvs: string[],
  onUndefined?: (varName: string, fullEnv: string) => void,
  variables: Readonly<Record<string, string>> = {},
): string | undefined {
  // Build a map of previously defined variables
  const definedVars: Record<string, string> = {};
  for (const env of previousEnvs) {
    const eqIndex = env.indexOf("=");
    if (eqIndex !== -1) {
      const key = env.slice(0, eqIndex);
      const val = env.slice(eqIndex + 1);
      definedVars[key] = val;
    }
  }

  // Check if this is an explicit assignment or passthrough
  const eqIndex = value.indexOf("=");

  if (eqIndex === -1) {
    // Passthrough: FOO -> pass through value from the host snapshot
    const envValue = variables[value];
    if (envValue === undefined) {
      return undefined;
    }
    return `${value}=${envValue}`;
  }

  // Explicit assignment: FOO=$BAR or FOO=literal
  const key = value.slice(0, eqIndex);
  const rawValue = value.slice(eqIndex + 1);

  // Expand variables in the value
  const expandedValue = expandEnvValue(
    rawValue,
    definedVars,
    (varName) => onUndefined?.(varName, value),
    variables,
  );

  return `${key}=${expandedValue}`;
}

/**
 * Parse and filter environment variables with variable expansion.
 * Supports $VAR and ${VAR} syntax for referencing other env vars.
 * Variables can reference earlier entries or the host snapshot.
 * Skips unset passthrough variables.
 */
export function parseEnvList(
  envList: string[],
  variables: Readonly<Record<string, string>>,
): string[] {
  const logger = getLogger();
  const results: string[] = [];

  for (const env of envList) {
    const expanded = parseEnvWithExpansion(
      env,
      results,
      (varName, fullEnv) => {
        logger.warn(`Undefined variable $${varName} in env: ${fullEnv}`);
      },
      variables,
    );

    if (expanded !== undefined) {
      results.push(expanded);

      // Log the result
      const [key] = expanded.split("=", 1);
      const isPassthrough = !env.includes("=");
      const hasExpansion = env.includes("$");
      const suffix = isPassthrough
        ? "<passthrough found>"
        : hasExpansion
          ? "<expanded>"
          : "<set>";
      logger.debug(`  ${key}=${suffix}`);
    } else {
      logger.debug(`  ${env}: <not set, skipped>`);
    }
  }

  if (envList.length > 0) {
    logger.debug(
      `Parsed ${results.length}/${envList.length} environment variables`,
    );
  }

  return results;
}
