import { getNetworkSessionEnvironment } from "#modules/network/index.js";
import { getLogger } from "#platform/logging/index.js";
import { windowsPathToDocker } from "#shared/text/index.js";
import {
  getSessionEnvironmentVariables,
  logEnvironmentVariables,
} from "./environment-arguments.js";

interface BuildExecArgsOptions {
  containerName: string;
  currentDir: string;
  command: string[];
  stdin: boolean;
  tty: boolean;
  environment: readonly string[];
  proxyEnabled: boolean;
  hostCommandEscapeEnvironment?: Readonly<Record<string, string>>;
  verbose?: boolean;
}

function buildSessionArgs(options: BuildExecArgsOptions): string[] {
  const { currentDir, proxyEnabled, verbose } = options;
  const logger = getLogger();
  const args = ["-w", windowsPathToDocker(currentDir)];
  logger.debug(`Working directory: ${windowsPathToDocker(currentDir)}`);

  const environment = new Map<string, string>();
  for (const assignment of options.environment) {
    const separator = assignment.indexOf("=");
    environment.set(
      assignment.slice(0, separator),
      assignment.slice(separator + 1),
    );
  }
  for (const { name, value } of getSessionEnvironmentVariables()) {
    if (value) environment.set(name, value);
  }
  for (const [name, value] of Object.entries(
    getNetworkSessionEnvironment(proxyEnabled),
  )) {
    environment.set(name, value);
  }
  for (const [name, value] of Object.entries(
    options.hostCommandEscapeEnvironment ?? {},
  )) {
    environment.set(name, value);
  }
  if (verbose) environment.set("SANDBOX_DEBUG", "1");
  const assignments = Array.from(
    environment,
    ([name, value]) => `${name}=${value}`,
  );
  logEnvironmentVariables("Session", assignments);
  for (const assignment of assignments) args.push("-e", assignment);
  return args;
}

export function buildExecArgs(options: BuildExecArgsOptions): string[] {
  const { containerName, command, stdin, tty } = options;
  const logger = getLogger();
  const args: string[] = [];
  if (stdin && tty) args.push("-it");
  else if (stdin) args.push("-i");
  else if (tty) args.push("-t");
  logger.debug(
    `Exec mode: stdin=${stdin ? "attached" : "detached"}, tty=${tty}`,
  );
  args.push(...buildSessionArgs(options));
  args.push(containerName, "/usr/local/bin/exec-entrypoint.sh", ...command);
  return args;
}
