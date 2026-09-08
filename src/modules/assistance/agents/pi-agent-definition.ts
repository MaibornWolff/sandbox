import {
  type AssistAgentDefinition,
  buildInlineSystemPromptSpec,
} from "./agent-definition.js";

export const PI_ASSIST_AGENT: AssistAgentDefinition = {
  name: "Pi",
  command: "pi",
  buildLaunchSpec: ({ prompt, question }) =>
    buildInlineSystemPromptSpec({
      command: "pi",
      prompt,
      question,
    }),
};
