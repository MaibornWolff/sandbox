import { getAssistAgentDefinition } from "./agent-catalog.js";
import {
  type AssistLaunchSpec,
  type BuildAssistLaunchSpecOptions,
  formatAssistLaunchCommand,
} from "./agent-definition.js";

export function buildAssistLaunchSpec(
  options: BuildAssistLaunchSpecOptions,
): AssistLaunchSpec {
  return getAssistAgentDefinition(options.agent).buildLaunchSpec(options);
}

export { formatAssistLaunchCommand };
