import { parse as parseToml, type TomlTableWithoutBigInt } from "smol-toml";
import {
  CommandPatternValidationError,
  validateHostCommandRule,
} from "#modules/host-command-escape/index.js";
import { readTextFile } from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import { validateConfig } from "./config-validation.js";
import { type TomlConfig, tomlConfigSchema } from "./toml-config-schema.js";

/** Keep parser failures inside the configuration-path error boundary. @testonly */
export function parseTomlDocument(
  content: string,
  configPath: string,
): TomlTableWithoutBigInt {
  try {
    return parseToml(content, { integersAsBigInt: false });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse config at ${configPath}: ${details}`, {
      cause: error,
    });
  }
}

function rejectLegacyHostCommandSyntax(
  rawConfig: TomlTableWithoutBigInt,
  configPath: string,
): void {
  const value = rawConfig.allow_host_commands;
  if (
    Array.isArray(value) &&
    value.some((entry) => typeof entry === "string")
  ) {
    throw new Error(
      `Invalid config at ${configPath}: allow_host_commands no longer accepts wildcard strings. Migrate each command to an array table, for example:\n\n[[allow_host_commands]]\npattern = ["bun", "run", "test:e2e"]`,
    );
  }
}

function validateHostCommandRules(
  config: TomlConfig,
  configPath: string,
): void {
  for (const [ruleIndex, rule] of (
    config.allow_host_commands ?? []
  ).entries()) {
    let failures: ReturnType<typeof validateHostCommandRule>;
    try {
      failures = validateHostCommandRule(rule);
    } catch (error) {
      if (!(error instanceof CommandPatternValidationError)) throw error;
      throw new Error(
        `Invalid host command rule in ${configPath}:\nrule ${ruleIndex + 1}: ${error.message}`,
        { cause: error },
      );
    }
    if (failures.length > 0) {
      const details = failures
        .map(
          (failure) =>
            `${failure.field}[${failure.index + 1}] ${failure.message} in rule ${ruleIndex + 1}:\n  ${JSON.stringify(failure.argv)}`,
        )
        .join("\n");
      throw new Error(
        `Invalid host command rule in ${configPath}:\n${details}`,
      );
    }
  }
}

/**
 * Load TOML config from file with Zod validation
 */
export function loadTomlConfig(configPath: string): TomlConfig | null {
  const logger = getLogger();
  let content: string;
  try {
    content = readTextFile(configPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      logger.debug(`Config file not found: ${configPath}`);
      return null;
    }
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read config at ${configPath}: ${details}`, {
      cause: error,
    });
  }
  const rawConfig = parseTomlDocument(content, configPath);
  rejectLegacyHostCommandSyntax(rawConfig, configPath);
  const result = tomlConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid config at ${configPath}:\n${issues}`, {
      cause: result.error,
    });
  }

  const config = result.data as TomlConfig;
  validateHostCommandRules(config, configPath);
  const validation = validateConfig(config);
  if (validation.errors.length > 0) {
    throw new Error(
      `Invalid config at ${configPath}:\n${validation.errors.map((error) => `  - ${error}`).join("\n")}`,
    );
  }

  logger.debug(`Loaded config from: ${configPath}`);
  return config;
}
