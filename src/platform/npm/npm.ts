import { getClock } from "#platform/clock/index.js";
import {
  ExecError,
  getProcessManager,
  type ManagedProcess,
  type ProcessResult,
} from "#platform/process/index.js";

const REGISTRY_HINT =
  "Check your network connection and configured npm registry.";

const PERMISSION_HINT =
  "npm cannot update the global package because of insufficient permissions. " +
  "Fix npm global installation permissions or use a Node.js version manager, then retry the update.";

async function boundedResult(
  child: ManagedProcess<ProcessResult>,
  timeout: number,
): Promise<ProcessResult> {
  const controller = new AbortController();
  using _deadline = { [Symbol.dispose]: () => controller.abort() };
  const expired = getClock()
    .sleep(timeout, { signal: controller.signal })
    .then(() => undefined);
  const result = await Promise.race([child.result, expired]);
  if (result !== undefined) return result;
  await child.stop({
    gracefulTimeoutMilliseconds: 1_000,
    forceTimeoutMilliseconds: 1_000,
  });
  throw new Error("npm update check timed out");
}

async function executeNpm(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly interactive?: boolean;
  readonly timeout?: number;
}): Promise<string> {
  await using child = getProcessManager().start({
    command: options.command,
    args: options.args,
    lifetime: "application",
    interaction: { mode: "non-interactive" },
    stdio: options.interactive ? "inherit" : "capture",
  });
  const result =
    options.timeout === undefined
      ? await child.result
      : await boundedResult(child, options.timeout);
  if (result.exitCode !== 0) {
    throw new ExecError(
      `${options.command} exited with code ${result.exitCode}`,
      result.exitCode,
      { stdout: result.stdout, stderr: result.stderr },
    );
  }
  return result.stdout;
}

function errorDetail(error: unknown): string {
  if (error instanceof ExecError) {
    return error.stderr || error.stdout || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function classifiedError(message: string, cause: unknown): Error {
  if (cause instanceof ExecError) {
    return new ExecError(message, cause.exitCode, {
      stdout: cause.stdout,
      stderr: cause.stderr,
    });
  }
  return new Error(message);
}

/** Fetch the latest version of a package from the npm registry. */
export async function fetchLatestVersion(packageName: string): Promise<string> {
  try {
    return (
      await executeNpm({
        command: "npm",
        args: ["view", packageName, "version"],
        timeout: 15_000,
      })
    ).trim();
  } catch (error) {
    const message = errorDetail(error);
    const firstLine = message.split("\n")[0];
    if (message.includes("E401") || message.includes("E403")) {
      throw classifiedError(
        `Failed to check for updates\n  ${firstLine}\n  ${REGISTRY_HINT}`,
        error,
      );
    }
    throw classifiedError(`Failed to check for updates\n  ${firstLine}`, error);
  }
}

/** Run a binary installed by the global package manager. */
export async function runGlobalPackageBinary(
  binaryName: string,
  args: readonly string[],
): Promise<void> {
  await executeNpm({ command: binaryName, args, interactive: true });
}

/** Run npm install -g to update a package globally. */
export async function updateGlobalPackage(packageName: string): Promise<void> {
  try {
    await executeNpm({
      command: "npm",
      args: ["install", "-g", `${packageName}@latest`],
      interactive: true,
    });
  } catch (error) {
    const message = errorDetail(error);
    if (message.includes("EACCES")) {
      throw classifiedError(
        `Update failed (permission denied)\n  ${PERMISSION_HINT}`,
        error,
      );
    }
    throw classifiedError(`Update failed\n  ${message.split("\n")[0]}`, error);
  }
}
