import { RUNTIME_IDS } from "#modules/configuration/index.js";
import { writeStandardOutput } from "#platform/terminal/index.js";
import { isPromptCancellation } from "#shared/errors/index.js";
import { initializeProject } from "./initialization/project-initialization.js";
import type { RuntimeSelection } from "./initialization/runtime-selection.js";
import { initializeUser } from "./initialization/user-initialization.js";

interface InitOptions {
  project?: boolean;
  tools?: string[];
  runtime?: string;
}

const RUNTIME_SELECTIONS: readonly RuntimeSelection[] = [
  ...RUNTIME_IDS,
  "auto",
];

type InitResult = "user" | "project" | "cancelled";

class ReportedInitError extends Error {
  readonly reported = true;
  readonly exitCode = 1;
}

function parseRuntimeSelection(
  value: string | undefined,
): RuntimeSelection | undefined {
  if (value === undefined) return undefined;
  const selection = RUNTIME_SELECTIONS.find((id) => id === value);
  if (selection) return selection;
  writeStandardOutput(`Unknown runtime: ${value}`);
  writeStandardOutput(`Valid runtimes: ${RUNTIME_SELECTIONS.join(", ")}`);
  throw new ReportedInitError(`Invalid --runtime option: ${value}`);
}

export async function initCommand(options: InitOptions): Promise<InitResult> {
  try {
    if (options.project && options.runtime !== undefined) {
      writeStandardOutput("--runtime cannot be used with --project");
      throw new ReportedInitError("Invalid --runtime option");
    }
    if (options.project) {
      await initializeProject(options.tools);
      return "project";
    }
    if (options.tools) {
      writeStandardOutput("--tools can only be used with --project");
      throw new ReportedInitError("Invalid --tools option");
    }
    const runtime = parseRuntimeSelection(options.runtime);
    await initializeUser({ runtime });
    return "user";
  } catch (error) {
    if (isPromptCancellation(error)) {
      writeStandardOutput("\nCancelled.");
      return "cancelled";
    }
    throw error;
  }
}
