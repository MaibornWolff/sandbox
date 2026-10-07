import chalk from "chalk";
import {
  getGlobalConfigPath,
  getGlobalDockerfilePath,
} from "#modules/configuration/index.js";
import { getSandboxSettings } from "#modules/sandbox-settings/index.js";
import { getHostEnvironment } from "#platform/environment/index.js";
import {
  promptSelectionConfirmation,
  selectCheckbox,
  writeStandardOutput,
} from "#platform/terminal/index.js";
import { getErrorMessage } from "#shared/errors/index.js";
import {
  applyBypassSettings,
  canAddBypass,
  canAddBypassDef,
  createMinimalBypassConfig,
} from "../agent-config-bypass.js";
import {
  type AgentConfigDef,
  getAgentConfigDefs,
} from "../agent-config-catalog.js";
import {
  copyPath,
  type DetectedConfig,
  getExistingTargetPaths,
} from "../agent-config-copying.js";
import { TOOL_REGISTRY } from "../tools/tool-registry.js";
import {
  displayAccessSummary,
  displayBypassExplanation,
  displayConfigLocations,
  displayInitAssistHint,
  displayReadyToGo,
} from "./initialization-display.js";
import { ensureSettingsGitignore } from "./settings-gitignore.js";

interface CopyResult {
  name: string;
  success: boolean;
  error?: string;
  copiedPaths: string[];
  overwrittenPaths: string[];
}

/**
 * Copy agent config files/folders to sandbox settings directory
 */
function copyAgentConfig(
  config: DetectedConfig,
  withBypass: boolean,
  homeDir?: string,
): CopyResult {
  const home = homeDir ?? getHostEnvironment().homeDirectory;
  const result: CopyResult = {
    name: config.name,
    success: true,
    copiedPaths: [],
    overwrittenPaths: [],
  };

  // Check which paths already exist in target
  const existingPaths = getExistingTargetPaths(config);

  try {
    // Copy each source path
    for (const [i, sourcePath] of config.sourcePaths.entries()) {
      const relativePath = config.relativePaths[i];
      if (!relativePath) continue;

      copyPath(sourcePath, home, config.targetBaseDir);

      if (existingPaths.includes(relativePath)) {
        result.overwrittenPaths.push(relativePath);
      } else {
        result.copiedPaths.push(relativePath);
      }
    }

    // Apply bypass settings if requested
    if (withBypass) {
      applyBypassSettings(config);
    }
  } catch (err) {
    result.success = false;
    result.error = getErrorMessage(err);
  }

  return result;
}

/**
 * Information about a config that will be created/overridden
 */
interface OverrideInfo {
  name: string;
  configDef: AgentConfigDef;
  /** Existing paths that will be overwritten */
  existingPaths: string[];
  /** True if this is a copy operation, false if bypass-only */
  isCopy: boolean;
}

/**
 * Get overrides for configs selected for copying
 */
function getCopyOverrides(
  selectedToCopy: DetectedConfig[],
  allConfigDefs: AgentConfigDef[],
): OverrideInfo[] {
  const overrides: OverrideInfo[] = [];

  for (const config of selectedToCopy) {
    const existingPaths = getExistingTargetPaths(config);
    if (existingPaths.length === 0) continue;

    const configDef = allConfigDefs.find((d) => d.name === config.name);
    if (!configDef) continue;

    overrides.push({
      name: config.name,
      configDef,
      existingPaths,
      isCopy: true,
    });
  }

  return overrides;
}

/**
 * Calculate which configs will be overridden by copy operations.
 * Only warns about configs the user explicitly selected to copy.
 * Bypass-only configs don't need override warnings since they're minimal.
 * @testonly
 */
export function calculateOverrides(
  selectedToCopy: DetectedConfig[],
  _allDetected: DetectedConfig[],
  _addBypass: boolean,
): OverrideInfo[] {
  const allConfigDefs = getAgentConfigDefs();
  return getCopyOverrides(selectedToCopy, allConfigDefs);
}

/**
 * Confirm with user about overriding existing configs
 * Returns set of agent names to skip (user declined override)
 */
async function confirmOverrides(
  overrides: OverrideInfo[],
): Promise<Set<string>> {
  if (overrides.length === 0) {
    return new Set();
  }

  writeStandardOutput();
  writeStandardOutput(chalk.bold("Existing agent configurations found:"));
  writeStandardOutput();

  for (const override of overrides) {
    const action = override.isCopy
      ? "copy will override"
      : "bypass will override";
    writeStandardOutput(`  ${override.name}: ${chalk.yellow(action)}`);
    for (const p of override.existingPaths) {
      writeStandardOutput(
        `    ${chalk.dim(`~/.config/sandbox/settings/${p}`)}`,
      );
    }
  }
  writeStandardOutput();

  const shouldOverride = await promptSelectionConfirmation({
    message: "Override existing configurations?",
    default: false,
  });

  if (shouldOverride) {
    return new Set();
  }

  // User declined - return all names to skip
  return new Set(overrides.map((o) => o.name));
}

/**
 * Result of creating a bypass-only config
 */
interface BypassOnlyResult {
  name: string;
  success: boolean;
}

/**
 * Display next steps after user-level init
 */
export function displayNextSteps(selectedToolIds: string[]): void {
  const configPath = getGlobalConfigPath();
  const dockerfilePath = getGlobalDockerfilePath();
  const settingsDir = getSandboxSettings().getHostDirectory();

  writeStandardOutput();
  displayAccessSummary();
  displayReadyToGo(selectedToolIds);
  displayConfigLocations(configPath, dockerfilePath, settingsDir);
  displayInitAssistHint();
}

/**
 * Selection item for agent config
 */
interface AgentSelection {
  name: string;
  configDef: AgentConfigDef;
  /** If set, this config can be copied from host */
  detectedConfig: DetectedConfig | null;
  /** True if this is a "create minimal" option (no host config to copy) */
  isCreateOnly: boolean;
}

/**
 * Get the set of agent config names that correspond to selected tool IDs.
 * Uses the agentConfigId field in tool definitions to link tools to agent configs.
 */
function getSelectedAgentConfigNames(selectedToolIds: string[]): Set<string> {
  const names = new Set<string>();
  for (const toolId of selectedToolIds) {
    const tool = TOOL_REGISTRY.find((t) => t.id === toolId);
    if (tool?.agentConfigId) {
      names.add(tool.agentConfigId);
    }
  }
  return names;
}

/**
 * Build list of all selectable agent configs
 * Includes detected configs (copy) and non-detected bypass-capable (create minimal)
 * Only includes configs that match selected tools (via agentConfigId)
 */
function buildAgentSelections(
  detectedConfigs: DetectedConfig[],
  selectedToolIds: string[],
): AgentSelection[] {
  const allConfigDefs = getAgentConfigDefs();
  const detectedNames = new Set(detectedConfigs.map((c) => c.name));
  const selectedAgentNames = getSelectedAgentConfigNames(selectedToolIds);
  const selections: AgentSelection[] = [];

  // Add detected configs (can be copied) - only if agent was selected as tool
  for (const config of detectedConfigs) {
    if (!selectedAgentNames.has(config.name)) continue;

    const configDef = allConfigDefs.find((d) => d.name === config.name);
    if (configDef) {
      selections.push({
        name: config.name,
        configDef,
        detectedConfig: config,
        isCreateOnly: false,
      });
    }
  }

  // Add non-detected configs that support bypass (can create minimal) - only if agent was selected as tool
  for (const configDef of allConfigDefs) {
    if (!selectedAgentNames.has(configDef.name)) continue;

    if (!detectedNames.has(configDef.name) && canAddBypassDef(configDef)) {
      selections.push({
        name: configDef.name,
        configDef,
        detectedConfig: null,
        isCreateOnly: true,
      });
    }
  }

  return selections;
}

/**
 * Build checkbox choices for agent selection
 * Warns about existing configs and doesn't preselect them
 */
function buildAgentChoices(
  selections: AgentSelection[],
): { name: string; value: number; checked: boolean }[] {
  return selections.map((selection, index) => {
    // Check if this would override existing config in sandbox settings
    const wouldOverride =
      selection.detectedConfig &&
      getExistingTargetPaths(selection.detectedConfig).length > 0;

    let action: string;
    if (selection.isCreateOnly) {
      action = chalk.dim("(Create)");
    } else if (wouldOverride) {
      action = chalk.yellow("(Copy, Override)");
    } else {
      action = chalk.dim("(Copy)");
    }

    return {
      name: `${selection.name.padEnd(12)} ${action}`,
      value: index,
      // Don't preselect if it would override existing or is create-only
      checked: !selection.isCreateOnly && !wouldOverride,
    };
  });
}

/**
 * Prompt user to select which agent configs to set up
 */
async function selectAgentConfigs(
  selections: AgentSelection[],
): Promise<AgentSelection[]> {
  if (selections.length === 0) {
    return [];
  }

  const choices = buildAgentChoices(selections);

  writeStandardOutput(chalk.bold("Agent configurations:\n"));

  const selectedIndices = await selectCheckbox({
    message: "Select configurations to copy or create:",
    choices,
    pageSize: 10,
    loop: false,
  });

  return selectedIndices
    .map((i) => selections[i])
    .filter((s): s is AgentSelection => s !== undefined);
}

/**
 * Ask user about bypass settings and show explanation
 */
async function promptBypassSettings(
  detectedConfigs: DetectedConfig[],
): Promise<boolean> {
  const allConfigDefs = getAgentConfigDefs();
  const bypassableConfigDefs = allConfigDefs.filter((d) => canAddBypassDef(d));

  if (bypassableConfigDefs.length === 0) {
    return false;
  }

  const bypassableDetected = detectedConfigs.filter((c) => canAddBypass(c));
  const bypassableDefs = bypassableConfigDefs.filter(
    (d) => !bypassableDetected.some((c) => c.name === d.name),
  );

  writeStandardOutput();
  writeStandardOutput(
    chalk.bold("Enable full permissions for AI agents inside sandbox?"),
  );
  displayBypassExplanation(bypassableDetected);

  // If there are bypassable agents not detected, mention them
  if (bypassableDefs.length > 0 && bypassableDetected.length > 0) {
    const otherNames = bypassableDefs.map((d) => d.name).join(", ");
    writeStandardOutput(chalk.dim(`  (Also available for: ${otherNames})`));
    writeStandardOutput();
  }

  return promptSelectionConfirmation({
    message: "Skip agent permission prompts inside the sandbox?",
    default: true,
  });
}

/**
 * Create bypass-only configs for agents not selected for copy
 * @testonly
 */
export function createBypassOnlyConfigs(
  copiedNames: Set<string>,
  skipNames: Set<string>,
): BypassOnlyResult[] {
  const allConfigDefs = getAgentConfigDefs();
  const settingsDir = getSandboxSettings().getHostDirectory();
  const results: BypassOnlyResult[] = [];

  for (const configDef of allConfigDefs) {
    const shouldSkip =
      copiedNames.has(configDef.name) ||
      skipNames.has(configDef.name) ||
      !canAddBypassDef(configDef);

    if (shouldSkip) continue;

    const success = createMinimalBypassConfig(configDef, settingsDir);
    results.push({ name: configDef.name, success });
  }

  return results;
}

/**
 * Process agent config selection, bypass, and overrides
 * Only shows configs for agents that were selected in tool selection
 */
export async function handleAgentConfigs(
  detectedConfigs: DetectedConfig[],
  selectedToolIds: string[],
): Promise<{
  selections: AgentSelection[];
  addBypass: boolean;
  skipNames: Set<string>;
}> {
  // Build all possible selections (detected + create-only), filtered by selected tools
  const allSelections = buildAgentSelections(detectedConfigs, selectedToolIds);

  if (allSelections.length === 0) {
    return { selections: [], addBypass: false, skipNames: new Set() };
  }

  // Step 1: Select which configs to set up
  const selectedSelections = await selectAgentConfigs(allSelections);

  if (selectedSelections.length === 0) {
    return { selections: [], addBypass: false, skipNames: new Set() };
  }

  // Step 2: Ask about bypass (only if any selection supports it)
  const hasBypassSupport = selectedSelections.some((s) =>
    canAddBypassDef(s.configDef),
  );
  const addBypass = hasBypassSupport
    ? await promptBypassSettings(detectedConfigs)
    : false;

  // Step 3: Confirm overrides (only for copy operations)
  const copySelections = selectedSelections.filter((s) => !s.isCreateOnly);
  const configsToCopy = copySelections
    .map((s) => s.detectedConfig)
    .filter((c): c is DetectedConfig => c !== null);

  let skipNames = new Set<string>();
  if (configsToCopy.length > 0) {
    const overrides = calculateOverrides(
      configsToCopy,
      detectedConfigs,
      addBypass,
    );
    skipNames = await confirmOverrides(overrides);
  }

  writeStandardOutput();

  const finalSelections = selectedSelections.filter(
    (s) => !skipNames.has(s.name),
  );
  return { selections: finalSelections, addBypass, skipNames };
}

/**
 * Process a single create-only selection
 */
function processCreateSelection(
  selection: AgentSelection,
  settingsDir: string,
): void {
  const success = createMinimalBypassConfig(selection.configDef, settingsDir);
  const status = success ? chalk.green("✓") : chalk.red("✗");
  const action = success ? "Created" : "Failed to create";
  writeStandardOutput(
    `${status} ${action} ${selection.name} config (bypass permissions)`,
  );
}

/**
 * Process a single copy selection
 */
function processCopySelection(
  selection: AgentSelection,
  addBypass: boolean,
): void {
  if (!selection.detectedConfig) return;

  const result = copyAgentConfig(selection.detectedConfig, addBypass);
  const status = result.success ? chalk.green("✓") : chalk.red("✗");
  const action = result.success ? "Copied" : "Failed to copy";
  const bypassNote =
    result.success && addBypass && canAddBypass(selection.detectedConfig)
      ? " (with bypass permissions)"
      : "";
  writeStandardOutput(`${status} ${action} ${selection.name}${bypassNote}`);
}

/**
 * Content for settings .gitignore to protect credential files
 */
/**
 * Process selected agent configs - copy or create as appropriate
 */
export function processAgentSelections(
  selections: AgentSelection[],
  addBypass: boolean,
): void {
  const settingsDir = getSandboxSettings().getHostDirectory();

  // Ensure .gitignore exists to protect credentials
  ensureSettingsGitignore();

  for (const selection of selections) {
    if (selection.isCreateOnly) {
      processCreateSelection(selection, settingsDir);
    } else {
      processCopySelection(selection, addBypass);
    }
  }
}
