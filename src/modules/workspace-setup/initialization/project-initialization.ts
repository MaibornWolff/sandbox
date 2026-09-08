import chalk from "chalk";
import {
  getProjectConfigPath,
  getProjectDockerfilePath,
} from "#modules/configuration/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import { getRepoRootPath } from "#platform/git/index.js";
import {
  promptSelectionConfirmation,
  writeStandardOutput,
} from "#platform/terminal/index.js";
import {
  createFilesSilently,
  processFileUpdates,
} from "../files/file-updating.js";
import { getProjectFileDefinitions } from "../files/generated-file-definition.js";
import { detectProjectCapabilities } from "../tools/detection.js";
import type { ToolDefinition } from "../tools/tool-definition.js";
import { TOOL_REGISTRY } from "../tools/tool-registry.js";
import { getToolsById, selectTools } from "../tools/tool-selection.js";
import {
  copyBuildContextFiles,
  detectBuildContextFiles,
} from "./build-context-detection.js";
import { displayInitAssistHint } from "./initialization-display.js";

function validateToolIds(toolIds: string[]): string[] {
  const validIds = TOOL_REGISTRY.map((tool) => tool.id);
  const invalidIds = toolIds.filter((id) => !validIds.includes(id));
  if (invalidIds.length > 0) {
    writeStandardOutput(
      chalk.red(`Unknown tool IDs: ${invalidIds.join(", ")}`),
    );
    writeStandardOutput(chalk.dim(`Valid IDs: ${validIds.join(", ")}`));
    throw new Error(`Unknown tool IDs: ${invalidIds.join(", ")}`);
  }
  return toolIds;
}

async function selectProjectTools(
  projectRoot: string,
  registry: ToolDefinition[],
): Promise<string[]> {
  const detectedTools = await detectProjectCapabilities(registry, projectRoot);
  for (const tool of detectedTools) {
    writeStandardOutput(
      chalk.dim(`ℹ Detected project files - ${tool.name} pre-selected`),
    );
  }
  writeStandardOutput(chalk.bold("Configure project capabilities:\n"));
  return selectTools({
    registry,
    projectLevel: true,
    preSelectedIds: detectedTools.map((tool) => tool.id),
  });
}

async function copySelectedBuildContextFiles(
  selectedToolIds: string[],
  projectRoot: string,
  currentDirectory: string,
): Promise<void> {
  const selectedTools = getToolsById(selectedToolIds);
  const detectedFiles = await detectBuildContextFiles(
    selectedTools,
    projectRoot,
  );
  copyBuildContextFiles(detectedFiles, currentDirectory);
}

function displayProjectNextSteps(): void {
  const cwd = getHostEnvironment().currentWorkingDirectory;
  writeStandardOutput(chalk.bold("\nNext steps"));
  writeStandardOutput(`  1. Edit ${chalk.cyan(getProjectConfigPath(cwd))}`);
  writeStandardOutput(
    chalk.dim("     Add project-specific env vars and mounts\n"),
  );
  writeStandardOutput(
    `  2. ${chalk.dim("(Optional)")} Add tools to ${chalk.cyan(getProjectDockerfilePath(cwd))}`,
  );
  writeStandardOutput(`     Then run: ${chalk.dim("sandbox build")}\n`);
  displayInitAssistHint();
}

export async function initializeProject(toolIds?: string[]): Promise<void> {
  const definitions = getProjectFileDefinitions();
  const configDefinitions = definitions.filter(
    (definition) => definition.id === "config",
  );
  const nonInteractive = toolIds !== undefined;
  const currentDirectory = getHostEnvironment().currentWorkingDirectory;
  if (!nonInteractive) {
    writeStandardOutput(
      chalk.bold("Initialize project-level sandbox configuration.\n"),
    );
    const customizeImage = await promptSelectionConfirmation({
      message: "Customize the project image?",
      default: false,
    });
    if (!customizeImage) {
      writeStandardOutput();
      await processFileUpdates(configDefinitions, []);
      writeStandardOutput();
      displayProjectNextSteps();
      return;
    }
  }

  const projectRoot = await getRepoRootPath(currentDirectory);
  const selectedToolIds = nonInteractive
    ? validateToolIds(toolIds)
    : await selectProjectTools(projectRoot, TOOL_REGISTRY);

  writeStandardOutput();
  if (nonInteractive) createFilesSilently(definitions, selectedToolIds);
  else {
    await processFileUpdates(definitions, selectedToolIds);
    writeStandardOutput();
  }

  await copySelectedBuildContextFiles(
    selectedToolIds,
    projectRoot,
    currentDirectory,
  );
  if (!nonInteractive) displayProjectNextSteps();
}
