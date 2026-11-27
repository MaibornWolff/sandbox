import chalk from "chalk";
import {
  selectCheckbox,
  writeStandardOutput,
} from "#platform/terminal/index.js";
import { detectExistingAgentConfigs } from "../agent-config-copying.js";
import { processFileUpdates } from "../files/file-updating.js";
import {
  detectExistingRuntime,
  detectExistingTools,
  getUserFileDefinitions,
} from "../files/generated-file-definition.js";
import {
  computeTemplateHashes,
  saveTemplateHashes,
} from "../files/template-hashing.js";
import { detectUserCapabilities } from "../tools/detection.js";
import type { ToolDefinition } from "../tools/tool-definition.js";
import { TOOL_REGISTRY } from "../tools/tool-registry.js";
import { selectTools } from "../tools/tool-selection.js";
import {
  displayNextSteps,
  handleAgentConfigs,
  processAgentSelections,
} from "./agent-configuration-flow.js";
import {
  displayFeatureOverview,
  displaySeparator,
  displayWelcome,
} from "./initialization-display.js";
import { type RuntimeSelection, selectRuntime } from "./runtime-selection.js";

function formatAgentChoice(tool: ToolDefinition): string {
  const documentation = tool.url ? ` (${tool.url})` : "";
  return `${tool.name.padEnd(12)} ${chalk.dim(`${tool.description}${documentation}`)}`;
}

async function selectInitialAgents(
  initialIds: readonly string[],
  registry: readonly ToolDefinition[],
): Promise<string[]> {
  const agents = registry.filter(
    (tool) => tool.category.section === "ai-agents",
  );
  const selected = new Set(initialIds);
  writeStandardOutput(chalk.bold("Select AI agents first:\n"));
  return selectCheckbox({
    message: "Select AI coding agents to add to sandbox:",
    choices: agents.map((tool) => ({
      name: formatAgentChoice(tool),
      short: tool.name,
      value: tool.id,
      checked: selected.has(tool.id),
    })),
    pageSize: 10,
    loop: false,
  });
}

async function getNewUserSelections(
  registry: readonly ToolDefinition[],
): Promise<string[]> {
  const detected = new Set(
    (await detectUserCapabilities(registry)).map((tool) => tool.id),
  );
  return registry
    .filter((tool) => tool.defaultForUserInit || detected.has(tool.id))
    .map((tool) => tool.id);
}

function replaceAgentSelections(
  initialIds: readonly string[],
  selectedAgentIds: readonly string[],
  registry: readonly ToolDefinition[],
): string[] {
  const agentIds = new Set(
    registry
      .filter((tool) => tool.category.section === "ai-agents")
      .map((tool) => tool.id),
  );
  return [...initialIds.filter((id) => !agentIds.has(id)), ...selectedAgentIds];
}

interface UserInitializationOptions {
  /** Runtime from the caller. Unset asks the user. */
  runtime?: RuntimeSelection;
}

/** Interactive flow for user-level init. */
export async function initializeUser(
  options: UserInitializationOptions = {},
): Promise<void> {
  displayWelcome();

  // Show feature overview
  displayFeatureOverview();
  displaySeparator();

  const definitions = getUserFileDefinitions();
  let runtimeSelection = options.runtime;
  if (runtimeSelection === undefined) {
    runtimeSelection = await selectRuntime(detectExistingRuntime(definitions));
    displaySeparator();
  }
  const runtime = runtimeSelection === "auto" ? undefined : runtimeSelection;
  const { toolIds: restoredIds, hasToolComment } =
    detectExistingTools(definitions);
  const userRegistry = TOOL_REGISTRY.filter((tool) => !tool.projectOnly);
  const initialIds = hasToolComment
    ? restoredIds
    : await getNewUserSelections(userRegistry);

  const selectedAgentIds = await selectInitialAgents(initialIds, userRegistry);
  displaySeparator();

  const preSelectedIds = replaceAgentSelections(
    initialIds,
    selectedAgentIds,
    userRegistry,
  );
  const selectedToolIds = await selectTools({ preSelectedIds });

  displaySeparator();

  // Agent settings stay after the complete capability review.
  const detectedConfigs = detectExistingAgentConfigs();
  const { selections, addBypass } = await handleAgentConfigs(
    detectedConfigs,
    selectedToolIds,
  );

  const choices = { toolIds: selectedToolIds, runtime };
  await processFileUpdates(definitions, choices);

  // Save template hashes so future updates can detect changes
  saveTemplateHashes(computeTemplateHashes(choices));

  writeStandardOutput();

  // Process agent configs
  processAgentSelections(selections, addBypass);

  displayNextSteps(selectedToolIds);
}
