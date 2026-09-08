import { defineCategory } from "../category-definition.js";
import { hasExecutable } from "../detection.js";
import { installNpmPackages, runImageSetupCommands } from "../image-setup.js";
import { definePreset } from "../preset-definition.js";
import { nodeTool } from "./javascript.js";

const aiAgents = defineCategory({
  id: "ai-agents",
  name: "AI coding agents",
  section: "ai-agents",
  description: "AI coding agents installed in the sandbox",
});

export const aiAgentsPreset = definePreset(aiAgents, [
  {
    id: "claude",
    name: "Claude Code",
    description: "Anthropic AI coding agent",
    category: aiAgents,
    detect: {
      duringUserInit: [hasExecutable("claude")],
      duringProjectInit: [],
    },
    imageSetup: {
      asContainerUser: [
        runImageSetupCommands([
          "curl -fsSL https://claude.ai/install.sh | bash",
        ]),
      ],
    },
    allowNetwork: ["*.claude.com", "claude.ai"],
    agentConfigId: "Claude Code",
    url: "https://code.claude.com/docs/en/overview",
  },
  {
    id: "copilot",
    name: "Copilot CLI",
    description: "GitHub Copilot coding agent",
    category: aiAgents,
    detect: {
      duringUserInit: [hasExecutable("copilot")],
      duringProjectInit: [],
    },
    imageSetup: {
      asContainerUser: [installNpmPackages(["@github/copilot@latest"])],
    },
    requires: [nodeTool],
    allowNetwork: ["api.business.githubcopilot.com"],
    agentConfigId: "Copilot",
    url: "https://github.com/features/copilot/cli",
  },
  {
    id: "codex",
    name: "OpenAI Codex",
    description: "OpenAI coding agent",
    category: aiAgents,
    detect: {
      duringUserInit: [hasExecutable("codex")],
      duringProjectInit: [],
    },
    imageSetup: {
      asContainerUser: [installNpmPackages(["@openai/codex@latest"])],
    },
    requires: [nodeTool],
    agentConfigId: "Codex",
    url: "https://developers.openai.com/codex/cli/",
  },
  {
    id: "opencode",
    name: "OpenCode",
    description: "Open-source coding agent",
    category: aiAgents,
    detect: {
      duringUserInit: [hasExecutable("opencode")],
      duringProjectInit: [],
    },
    imageSetup: {
      asContainerUser: [installNpmPackages(["opencode-ai@latest"])],
    },
    requires: [nodeTool],
    allowNetwork: ["opencode.ai", "models.dev"],
    agentConfigId: "OpenCode",
    url: "https://opencode.ai",
  },
  {
    id: "pi",
    name: "Pi",
    description: "Minimal, extensible, open-source coding Agent",
    category: aiAgents,
    detect: {
      duringUserInit: [hasExecutable("pi")],
      duringProjectInit: [],
    },
    imageSetup: {
      asContainerUser: [
        installNpmPackages(["@earendil-works/pi-coding-agent@latest"]),
      ],
    },
    requires: [nodeTool],
    agentConfigId: "Pi",
    url: "https://github.com/badlogic/pi-mono",
  },
]);
