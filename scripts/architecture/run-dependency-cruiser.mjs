#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { cruise } from "dependency-cruiser";

export function validateCruiseResult(output) {
  if (
    typeof output !== "object" ||
    output === null ||
    !Array.isArray(output.modules) ||
    typeof output.summary !== "object" ||
    output.summary === null ||
    !Array.isArray(output.summary.violations)
  ) {
    throw new Error("dependency-cruiser returned an invalid result");
  }
  return output;
}

export async function runDependencyCruiser({ configPath, input, tsconfig }) {
  const configuration = JSON.parse(await readFile(configPath, "utf8"));
  if (!Array.isArray(configuration.forbidden) || !configuration.options) {
    throw new Error(`Invalid architecture configuration: ${configPath}`);
  }

  const result = await cruise([input], {
    ...configuration.options,
    baseDir: process.cwd(),
    outputType: "json",
    ruleSet: { forbidden: configuration.forbidden },
    tsConfig: { fileName: tsconfig },
    validate: true,
  });

  if (result.exitCode !== 0 && typeof result.output === "string") {
    throw new Error(result.output);
  }
  return validateCruiseResult(
    typeof result.output === "string"
      ? JSON.parse(result.output)
      : result.output,
  );
}

async function main() {
  const [configPath, input, tsconfig] = process.argv.slice(2);
  if (!configPath || !input || !tsconfig) {
    throw new Error(
      "Usage: run-dependency-cruiser.mjs <config> <input> <tsconfig>",
    );
  }
  const result = await runDependencyCruiser({ configPath, input, tsconfig });
  process.stdout.write(JSON.stringify(result));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
