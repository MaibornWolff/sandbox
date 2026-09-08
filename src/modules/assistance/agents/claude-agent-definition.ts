import {
  type AssistAgentDefinition,
  buildInlineSystemPromptSpec,
} from "./agent-definition.js";

export const CLAUDE_ASSIST_AGENT: AssistAgentDefinition = {
  name: "Claude Code",
  command: "claude",
  buildLaunchSpec: ({ prompt, question }) =>
    buildInlineSystemPromptSpec({
      command: "claude",
      prompt,
      question,
    }),
};
