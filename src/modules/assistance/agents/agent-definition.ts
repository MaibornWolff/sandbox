import * as path from "node:path";
import { createTemporaryDirectory } from "#platform/filesystem/index.js";
import { shellQuote } from "#shared/text/index.js";

export interface AgentInfo {
  name: string;
  command: string;
}

export interface AssistContextFile {
  path: string;
  content: string;
}

export interface AssistLaunchSpec {
  cmd: string;
  args: string[];
  contextFile?: AssistContextFile;
  requiresManualStart?: boolean;
}

export interface BuildAssistLaunchSpecOptions {
  agent: AgentInfo;
  prompt: string;
  question?: string;
}

export interface AssistAgentDefinition extends AgentInfo {
  buildLaunchSpec: (options: BuildAssistLaunchSpecOptions) => AssistLaunchSpec;
}

const ASSIST_CONTEXT_FILE_NAME = "sandbox-assist-context.md";

export function buildInlineSystemPromptSpec(options: {
  command: string;
  prompt: string;
  question?: string;
}): AssistLaunchSpec {
  const { command, prompt, question } = options;
  return {
    cmd: command,
    args: question
      ? ["--append-system-prompt", prompt, question]
      : ["--append-system-prompt", prompt],
  };
}

function buildContextFile(prompt: string): AssistContextFile {
  const tempDir = createTemporaryDirectory("sandbox-assist-");
  return {
    path: path.join(tempDir, ASSIST_CONTEXT_FILE_NAME),
    content: prompt,
  };
}

function buildContextQuestionPrompt(options: {
  contextFilePath: string;
  question: string;
}): string {
  const { contextFilePath, question } = options;
  return `Read the sandbox context file at "${contextFilePath}" first.\n\nThen answer this question:\n${question}`;
}

function buildManualStartSpec(options: {
  command: string;
  prompt: string;
}): AssistLaunchSpec {
  const { command, prompt } = options;
  return {
    cmd: command,
    args: [],
    contextFile: buildContextFile(prompt),
    requiresManualStart: true,
  };
}

export function buildContextPromptSpec(options: {
  command: string;
  prompt: string;
  question?: string;
  buildArgs: (questionPrompt: string) => string[];
}): AssistLaunchSpec {
  const { command, prompt, question, buildArgs } = options;
  if (!question) {
    return buildManualStartSpec({ command, prompt });
  }

  const contextFile = buildContextFile(prompt);
  const questionPrompt = buildContextQuestionPrompt({
    contextFilePath: contextFile.path,
    question,
  });

  return {
    cmd: command,
    args: buildArgs(questionPrompt),
    contextFile,
  };
}

export function buildFallbackSpec(
  options: BuildAssistLaunchSpecOptions,
): AssistLaunchSpec {
  const { agent, prompt, question } = options;
  if (!question) {
    return buildManualStartSpec({ command: agent.command, prompt });
  }

  const contextFile = buildContextFile(prompt);
  const questionPrompt = buildContextQuestionPrompt({
    contextFilePath: contextFile.path,
    question,
  });

  return {
    cmd: agent.command,
    args: [questionPrompt],
    contextFile,
  };
}

export function formatAssistLaunchCommand(spec: {
  cmd: string;
  args: string[];
}): string {
  const displayArgs = spec.args.map(shellQuote).join(" ");
  return displayArgs ? `${spec.cmd} ${displayArgs}` : spec.cmd;
}
