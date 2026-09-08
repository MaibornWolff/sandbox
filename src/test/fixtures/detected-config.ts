import type { DetectedConfig } from "#modules/workspace-setup/index.js";

/**
 * Test fixture for Claude Code detected config
 */
export const claudeCodeConfig: DetectedConfig = {
  name: "Claude Code",
  displayPath: ".claude",
  sourcePaths: ["/home/user/.claude/settings.json"],
  relativePaths: [".claude/settings.json"],
  targetBaseDir: "/home/user/.config/sandbox/settings",
  settingsFileRelative: ".claude/settings.json",
  addBypassSettings: (parsed) => {
    parsed.defaultMode = "bypassPermissions";
  },
};

/**
 * Test fixture for Codex detected config
 */
export const codexConfig: DetectedConfig = {
  name: "Codex",
  displayPath: ".codex",
  sourcePaths: ["/home/user/.codex/config.toml"],
  relativePaths: [".codex/config.toml"],
  targetBaseDir: "/home/user/.config/sandbox/settings",
  settingsFileRelative: ".codex/config.toml",
  addBypassSettings: (parsed) => {
    parsed.approval_policy = "never";
  },
};

/**
 * Test fixture for OpenCode detected config (no bypass settings)
 */
export const openCodeConfig: DetectedConfig = {
  name: "OpenCode",
  displayPath: ".config/opencode",
  sourcePaths: ["/home/user/.config/opencode"],
  relativePaths: [".config/opencode"],
  targetBaseDir: "/home/user/.config/sandbox/settings",
  settingsFileRelative: null,
  addBypassSettings: null,
};
