/**
 * Agent configuration definition
 */
export interface AgentConfigDef {
  name: string;
  /** Path to display (relative to home, e.g., ".claude") */
  displayPath: string;
  /** Paths relative to home dir to copy (files and folders) */
  pathsToCopy: string[];
  /** The settings file to modify for bypass (relative to home), or null if no bypass */
  settingsFile: string | null;
  /** Function to add bypass settings to parsed JSON, or null if no bypass */
  addBypassSettings: ((parsed: Record<string, unknown>) => void) | null;
}

/**
 * Known agent configuration locations
 */
export const AGENT_CONFIGS: AgentConfigDef[] = [
  {
    name: "Claude Code",
    displayPath: ".claude",
    pathsToCopy: [
      ".claude/settings.json",
      ".claude/CLAUDE.md",
      ".claude/skills/",
      ".claude/agents/",
      ".claude/commands/",
      ".claude/hooks/",
      ".claude/scripts/",
    ],
    settingsFile: ".claude/settings.json",
    addBypassSettings: (parsed) => {
      if (!parsed.permissions) {
        parsed.permissions = {};
      }
      (parsed.permissions as Record<string, unknown>).defaultMode =
        "bypassPermissions";
    },
  },
  {
    name: "Codex",
    displayPath: ".codex",
    pathsToCopy: [
      ".codex/config.toml",
      ".codex/AGENTS.md",
      ".codex/skills/",
      ".codex/prompts/",
      ".codex/rules/",
    ],
    settingsFile: ".codex/config.toml",
    addBypassSettings: (parsed) => {
      parsed.approval_policy = "never";
      parsed.sandbox_mode = "danger-full-access";
    },
  },
  {
    name: "OpenCode",
    displayPath: ".config/opencode",
    pathsToCopy: [".config/opencode/"],
    settingsFile: null,
    addBypassSettings: null,
  },
  {
    name: "Pi",
    displayPath: ".pi",
    pathsToCopy: [
      ".pi/config.json",
      ".pi/agent/",
      ".pi/extensions/",
      ".pi/themes/",
    ],
    settingsFile: ".pi/config.json",
    addBypassSettings: (parsed) => {
      parsed.dangerouslySkipPermissions = true;
    },
  },
  {
    name: "Copilot",
    displayPath: ".copilot",
    pathsToCopy: [".copilot/config.json"],
    // No bypass: --allow-all is a CLI flag, not persisted in config
    settingsFile: null,
    addBypassSettings: null,
  },
];

export function getAgentConfigDefs(): AgentConfigDef[] {
  return AGENT_CONFIGS;
}
