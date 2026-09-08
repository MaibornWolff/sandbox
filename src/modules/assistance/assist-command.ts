import * as path from "node:path";
import chalk from "chalk";
import {
  removeDirectory,
  removeFile,
  writeTextFile,
} from "#platform/filesystem/index.js";
import { getLogger } from "#platform/logging/index.js";
import {
  getTerminal,
  launchInteractiveAgent,
} from "#platform/terminal/index.js";
import type { AssistContextFile } from "./agents/agent-definition.js";
import { resolveAgent } from "./agents/agent-detection.js";
import {
  buildAssistLaunchSpec,
  formatAssistLaunchCommand,
} from "./agents/agent-launch.js";
import { buildAssistPrompt } from "./assist-prompt.js";

interface AssistOptions {
  question?: string;
  agent?: string;
}

function writeContextFile(
  contextFile: AssistContextFile | undefined,
): string | null {
  if (!contextFile) return null;
  writeTextFile(contextFile.path, contextFile.content);
  return contextFile.path;
}

async function cleanupContextFile(
  contextFile: AssistContextFile | undefined,
): Promise<void> {
  if (!contextFile) return;

  try {
    await removeFile(contextFile.path);
  } catch (error) {
    getLogger().debug(
      `Could not remove assist context file ${contextFile.path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    removeDirectory(path.dirname(contextFile.path));
  } catch (error) {
    getLogger().debug(
      `Could not remove assist context directory ${path.dirname(contextFile.path)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function assistCommand(options: AssistOptions): Promise<number> {
  const terminal = getTerminal();
  const logger = getLogger();
  const agent = resolveAgent(options.agent);
  const prompt = await buildAssistPrompt();
  const launchSpec = buildAssistLaunchSpec({
    agent,
    prompt,
    question: options.question,
  });

  terminal.stdout.write(
    `Launching ${chalk.cyan(agent.name)} with sandbox context...\n`,
  );
  logger.debug(
    `Starting assist agent: ${formatAssistLaunchCommand(launchSpec)}`,
  );

  let shouldCleanupContextFile = true;

  try {
    const contextFilePath = writeContextFile(launchSpec.contextFile);

    if (launchSpec.requiresManualStart) {
      shouldCleanupContextFile = false;
      terminal.stdout.write(
        `${chalk.yellow(agent.name)} does not support automatic interactive sandbox assist mode.\n`,
      );
      terminal.stdout.write(
        `Sandbox context written to ${chalk.dim(contextFilePath ?? "unknown")}.\n`,
      );
      terminal.stdout.write(
        `Open ${chalk.cyan(agent.command)} manually and ask it to read that file.\n`,
      );
      terminal.stdout.write(
        `Or run ${chalk.cyan(`sandbox assist --agent ${agent.command} "your question"`)} for one-shot help.\n`,
      );
      return 0;
    }

    let exitCode: number;
    try {
      exitCode = await launchInteractiveAgent(launchSpec.cmd, launchSpec.args);
    } catch (error) {
      terminal.stderr.write(
        `Failed to launch ${chalk.cyan(agent.name)}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      exitCode = 1;
    }
    return exitCode;
  } finally {
    if (shouldCleanupContextFile) {
      await cleanupContextFile(launchSpec.contextFile);
    }
  }
}
