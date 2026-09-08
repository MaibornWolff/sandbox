import {
  type AssistAgentDefinition,
  buildContextPromptSpec,
} from "./agent-definition.js";

export const CODEX_ASSIST_AGENT: AssistAgentDefinition = {
  name: "Codex",
  command: "codex",
  buildLaunchSpec: ({ prompt, question }) =>
    buildContextPromptSpec({
      command: "codex",
      prompt,
      question,
      buildArgs: (questionPrompt) => [questionPrompt],
    }),
};
