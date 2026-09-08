import {
  type AgentInfo,
  type AssistAgentDefinition,
  buildFallbackSpec,
} from "./agent-definition.js";
import { CLAUDE_ASSIST_AGENT } from "./claude-agent-definition.js";
import { CODEX_ASSIST_AGENT } from "./codex-agent-definition.js";
import { COPILOT_ASSIST_AGENT } from "./copilot-agent-definition.js";
import { OPENCODE_ASSIST_AGENT } from "./opencode-agent-definition.js";
import { PI_ASSIST_AGENT } from "./pi-agent-definition.js";

const KNOWN_ASSIST_AGENTS: AssistAgentDefinition[] = [
  CLAUDE_ASSIST_AGENT,
  CODEX_ASSIST_AGENT,
  COPILOT_ASSIST_AGENT,
  PI_ASSIST_AGENT,
  OPENCODE_ASSIST_AGENT,
];

export function getAssistAgentDefinition(
  agent: AgentInfo,
): AssistAgentDefinition {
  return (
    KNOWN_ASSIST_AGENTS.find(
      (candidate) => candidate.command === agent.command,
    ) ?? {
      ...agent,
      buildLaunchSpec: buildFallbackSpec,
    }
  );
}

export function getSupportedAssistAgents(): AgentInfo[] {
  return KNOWN_ASSIST_AGENTS.map(({ name, command }) => ({ name, command }));
}
