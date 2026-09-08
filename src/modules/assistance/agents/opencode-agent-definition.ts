import {
  type AssistAgentDefinition,
  buildContextPromptSpec,
} from "./agent-definition.js";

export const OPENCODE_ASSIST_AGENT: AssistAgentDefinition = {
  name: "OpenCode",
  command: "opencode",
  buildLaunchSpec: ({ prompt, question }) =>
    buildContextPromptSpec({
      command: "opencode",
      prompt,
      question,
      buildArgs: (questionPrompt) => ["--prompt", questionPrompt],
    }),
};
