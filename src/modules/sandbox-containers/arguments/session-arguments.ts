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
  proxyEnabled: boolean;
  hostCommandEscapeEnvironment?: Readonly<Record<string, string>>;
  verbose?: boolean;
}

function buildSessionArgs(options: {
  currentDir: string;
  proxyEnabled: boolean;
  hostCommandEscapeEnvironment?: Readonly<Record<string, string>>;
  verbose?: boolean;
}): string[] {
  const { currentDir, proxyEnabled, verbose } = options;
  const logger = getLogger();
  const args = ["-w", windowsPathToDocker(currentDir)];
  logger.debug(`Working directory: ${windowsPathToDocker(currentDir)}`);

  const passthroughVars = getSessionEnvironmentVariables();
  for (const { name, value } of passthroughVars) {
    if (value) args.push("-e", `${name}=${value}`);
  }
  for (const [name, value] of Object.entries(
    getNetworkSessionEnvironment(proxyEnabled),
  )) {
    args.push("-e", `${name}=${value}`);
  }
  for (const [name, value] of Object.entries(
    options.hostCommandEscapeEnvironment ?? {},
  )) {
    args.push("-e", `${name}=${value}`);
  }
  logEnvironmentVariables(
    passthroughVars
      .filter(({ value }) => value)
      .map(({ name, value }) => `${name}=${value}`),
  );
  if (verbose) args.push("-e", "SANDBOX_DEBUG=1");
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
