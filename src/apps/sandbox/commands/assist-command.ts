import type { Command } from "commander";
import { assistCommand } from "#modules/assistance/index.js";

class AssistExitError extends Error {
  readonly reported = true;

  constructor(readonly exitCode: number) {
    super(`Assist agent exited with code ${exitCode}`);
  }
}

export function registerAssistCommand(program: Command): void {
  program
    .command("assist")
    .description("Get AI-assisted help with sandbox configuration")
    .argument(
      "[question]",
      "Question to ask (interactive when supported, manual handoff otherwise)",
    )
    .option(
      "--agent <command>",
      "AI agent command to use (default: auto-detect)",
    )
    .addHelpText(
      "after",
      `
Examples:
  $ sandbox assist                                    # Interactive help session when supported
  $ sandbox assist "How do I allow a new domain?"     # Ask a specific question
  $ sandbox assist --agent pi "Configure mounts"      # Use a specific agent
  $ sandbox assist --agent codex "Explain this setup" # Use Codex

Some agents need a question for automatic launch.
Without a question, sandbox may write the context to a temp file and tell you how to continue manually.
`,
    )
    .action(async (question, options) => {
      const exitCode = await assistCommand({
        question,
        agent: options.agent,
      });
      if (exitCode !== 0) throw new AssistExitError(exitCode);
    });
}
