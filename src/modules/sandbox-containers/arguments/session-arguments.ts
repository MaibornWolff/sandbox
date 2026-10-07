import { getNetworkSessionEnvironment } from "#modules/network/index.js";
import type {
  SandboxExecSpec,
  TerminalSessionOptions,
} from "#platform/container-runtime/index.js";
import { getLogger } from "#platform/logging/index.js";
import { windowsPathToDocker } from "#shared/text/index.js";
import {
  getSessionEnvironmentVariables,
  logEnvironmentVariables,
} from "./environment-arguments.js";

interface BuildSandboxExecSpecOptions {
  readonly currentDir: string;
  readonly command: readonly string[];
  readonly stdin: boolean;
  readonly tty: boolean;
  readonly environment: readonly string[];
  readonly proxyEnabled: boolean;
  readonly sessionEnvironment?: Readonly<Record<string, string>>;
  readonly verbose?: boolean;
}

export function buildSandboxExecSpec(options: BuildSandboxExecSpecOptions): {
  readonly spec: SandboxExecSpec;
  readonly session: TerminalSessionOptions;
} {
  const environment: Record<string, string> = {};
  for (const assignment of options.environment) {
    const separator = assignment.indexOf("=");
    environment[assignment.slice(0, separator)] = assignment.slice(
      separator + 1,
    );
  }
  const passthroughVariables = getSessionEnvironmentVariables().filter(
    (entry): entry is { name: string; value: string } =>
      entry.value !== undefined && entry.value !== "",
  );
  for (const { name, value } of passthroughVariables) {
    environment[name] = value;
  }
  Object.assign(
    environment,
    getNetworkSessionEnvironment(options.proxyEnabled),
    options.sessionEnvironment ?? {},
  );
  if (options.verbose) environment.SANDBOX_DEBUG = "1";
  logEnvironmentVariables(
    "Session",
    Object.entries(environment).map(([name, value]) => `${name}=${value}`),
  );
  const workingDirectory = windowsPathToDocker(options.currentDir);
  getLogger().debug(`Working directory: ${workingDirectory}`);
  getLogger().debug(
    `Exec mode: stdin=${options.stdin ? "attached" : "detached"}, tty=${options.tty}`,
  );
  return {
    spec: {
      command: ["/usr/local/bin/exec-entrypoint.sh", ...options.command],
      environment,
      workingDirectory,
    },
    session: {
      attachStdin: options.stdin,
      allocateTerminal: options.tty,
    },
  };
}
