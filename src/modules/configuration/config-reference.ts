import chalk from "chalk";
import { CONFIG_FIELD_CATALOG } from "./config-field-catalog.js";

/** @testonly */
export interface ConfigFieldInfo {
  tomlName: string;
  type: string;
  description: string;
  mergeStrategy: string;
  default: string;
  examples: string[];
}

/** Format a default value for display */
function formatDefault(value: unknown): string {
  if (value === undefined) return "none";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

/**
 * Get config field info for all fields in the TOML schema,
 * combining schema metadata, defaults, and merge rules.
 * @testonly
 */
export function getConfigFields(): ConfigFieldInfo[] {
  return Object.entries(CONFIG_FIELD_CATALOG).map(([tomlName, field]) => ({
    tomlName,
    type: field.type,
    description: field.description,
    mergeStrategy: field.mergeStrategy,
    default: formatDefault(field.defaultValue),
    examples: [...field.examples],
  }));
}

/**
 * Format the config reference as text (terminal) or markdown.
 */
export function formatConfigReference(format: "text" | "markdown"): string {
  const fields = getConfigFields();

  if (format === "markdown") {
    return formatMarkdown(fields);
  }
  return formatText(fields);
}

function formatMergeStrategy(strategy: string): string {
  const tag = `[${strategy}]`;
  return strategy === "accumulate" ? chalk.green(tag) : chalk.magenta(tag);
}

function formatText(fields: ConfigFieldInfo[]): string {
  const lines: string[] = [];
  lines.push(chalk.bold("Sandbox Configuration Schema"));
  lines.push(chalk.dim("============================="));
  lines.push("");
  lines.push(
    `${chalk.dim("Fields marked")} ${chalk.green("[accumulate]")} ${chalk.dim("are merged across config layers.")}`,
  );
  lines.push(
    `${chalk.dim("Fields marked")} ${chalk.magenta("[override]")} ${chalk.dim("use last-wins semantics.")}`,
  );
  lines.push(
    `${chalk.dim("See:")} ${chalk.cyan("sandbox config show")} ${chalk.dim("(on host) to view your merged configuration.")}`,
  );
  lines.push("");

  for (const field of fields) {
    const plainTag = `[${field.mergeStrategy}]`;
    const padding = Math.max(1, 65 - field.tomlName.length - plainTag.length);
    lines.push(
      `${chalk.bold.cyan(field.tomlName)}${" ".repeat(padding)}${formatMergeStrategy(field.mergeStrategy)}`,
    );
    lines.push(`  ${field.description}`);
    lines.push(`  ${chalk.cyan("Type:")} ${chalk.yellow(field.type)}`);
    lines.push(`  ${chalk.cyan("Default:")} ${chalk.green(field.default)}`);

    for (const example of field.examples) {
      lines.push(`  ${chalk.cyan("Example:")} ${chalk.blue(example)}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

function formatMarkdown(fields: ConfigFieldInfo[]): string {
  const lines: string[] = [];
  lines.push("# Sandbox Configuration Schema");
  lines.push("");
  lines.push("Fields marked **accumulate** are merged across config layers.");
  lines.push("Fields marked **override** use last-wins semantics.");
  lines.push("");

  for (const field of fields) {
    lines.push(`## \`${field.tomlName}\``);
    lines.push("");
    lines.push(`> ${field.description}`);
    lines.push("");
    lines.push(`- **Merge strategy:** ${field.mergeStrategy}`);
    lines.push(`- **Type:** \`${field.type}\``);
    lines.push(`- **Default:** \`${field.default}\``);

    for (const example of field.examples) {
      lines.push(`- **Example:** \`${example}\``);
    }

    lines.push("");
  }

  return lines.join("\n");
}
