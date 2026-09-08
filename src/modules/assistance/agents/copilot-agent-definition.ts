import {
  type AssistAgentDefinition,
  buildContextPromptSpec,
} from "./agent-definition.js";

export const COPILOT_ASSIST_AGENT: AssistAgentDefinition = {
  name: "GitHub Copilot",
  command: "copilot",
  buildLaunchSpec: ({ prompt, question }) =>
    buildContextPromptSpec({
      command: "copilot",
      prompt,
      question,
      buildArgs: (questionPrompt) => ["-i", questionPrompt],
    }),
};
