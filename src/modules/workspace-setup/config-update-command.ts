import chalk from "chalk";
import { writeStandardOutput } from "#platform/terminal/index.js";
import { isPromptCancellation } from "#shared/errors/index.js";
import { processFileUpdates } from "./files/file-updating.js";
import {
  detectExistingTools,
  type FileDefinition,
  getProjectFileDefinitions,
  getUserFileDefinitions,
  hasExistingConfig,
} from "./files/generated-file-definition.js";
import {
  computeTemplateHashes,
  saveTemplateHashes,
} from "./files/template-hashing.js";
import { selectTools } from "./tools/tool-selection.js";

interface ConfigUpdateOptions {
  project?: boolean;
}

async function resolveToolIds(
  definitions: FileDefinition[],
  options: ConfigUpdateOptions,
): Promise<string[]> {
  const detected = detectExistingTools(definitions);

  if (detected.hasToolComment) {
    for (const id of detected.unknown) {
      writeStandardOutput(
        chalk.yellow(`ℹ Skipping unknown tool: ${id} (no longer available)`),
      );
    }
    return detected.toolIds;
  }

  if (detected.hasDockerfile) {
    writeStandardOutput(
      chalk.dim("ℹ Could not detect tools from Dockerfile.\n"),
    );
    writeStandardOutput(chalk.bold("Select tools to regenerate Dockerfile:\n"));
    const selectOptions = options.project
      ? { excludeCategories: ["ai-agents" as const], projectLevel: true }
      : {};
    const toolIds = await selectTools(selectOptions);
    writeStandardOutput();
    return toolIds;
  }

  return [];
}

export async function configUpdateCommand(
  options: ConfigUpdateOptions = {},
): Promise<void> {
  try {
    const definitions = options.project
      ? getProjectFileDefinitions()
      : getUserFileDefinitions();

    if (!hasExistingConfig(definitions)) {
      const command = options.project
        ? "sandbox init --project"
        : "sandbox init";
      writeStandardOutput("No existing configuration found.");
      writeStandardOutput(`Run ${chalk.cyan(command)} first.`);
      return;
    }

    writeStandardOutput("Checking for configuration updates...\n");
    const toolIds = await resolveToolIds(definitions, options);
    await processFileUpdates(definitions, toolIds);

    if (!options.project) {
      saveTemplateHashes(computeTemplateHashes(toolIds));
    }

    writeStandardOutput(
      `Done. Run ${chalk.cyan("sandbox build")} if any Dockerfile changed.`,
    );
  } catch (error) {
    if (isPromptCancellation(error)) {
      writeStandardOutput("\nCancelled.");
      return;
    }
    throw error;
  }
}
