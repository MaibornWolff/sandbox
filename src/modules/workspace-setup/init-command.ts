import { writeStandardOutput } from "#platform/terminal/index.js";
import { isPromptCancellation } from "#shared/errors/index.js";
import { initializeProject } from "./initialization/project-initialization.js";
import { initializeUser } from "./initialization/user-initialization.js";

interface InitOptions {
  project?: boolean;
  tools?: string[];
}

type InitResult = "user" | "project" | "cancelled";

class ReportedInitError extends Error {
  readonly reported = true;
  readonly exitCode = 1;
}

export async function initCommand(options: InitOptions): Promise<InitResult> {
  try {
    if (options.project) {
      await initializeProject(options.tools);
      return "project";
    }
    if (options.tools) {
      writeStandardOutput("--tools can only be used with --project");
      throw new ReportedInitError("Invalid --tools option");
    }
    await initializeUser();
    return "user";
  } catch (error) {
    if (isPromptCancellation(error)) {
      writeStandardOutput("\nCancelled.");
      return "cancelled";
    }
    throw error;
  }
}
