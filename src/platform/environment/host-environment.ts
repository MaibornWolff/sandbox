import * as os from "node:os";
import * as path from "node:path";
import {
  createDependency,
  type DependencyBinding,
} from "#platform/dependency-injection/index.js";

export interface HostEnvironment {
  readonly currentWorkingDirectory: string;
  readonly executablePath?: string;
  readonly homeDirectory: string;
  readonly configHomeDirectory: string;
  readonly dataHomeDirectory: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
  readonly interactive: boolean;
}

const hostEnvironmentDependency =
  createDependency<HostEnvironment>("host environment");

export function provideHostEnvironment(
  environment: HostEnvironment,
): DependencyBinding {
  return hostEnvironmentDependency.provide(environment);
}

export function getHostEnvironment(): HostEnvironment {
  return hostEnvironmentDependency.get();
}

interface HostEnvironmentValues {
  readonly currentWorkingDirectory: string;
  readonly executablePath?: string;
  readonly homeDirectory: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
  readonly interactive: boolean;
}

function getDefaultApplicationDataDirectory(
  homeDirectory: string,
  platform: NodeJS.Platform,
  variables: Readonly<Record<string, string>>,
): string {
  if (platform === "win32") {
    return variables.APPDATA ?? path.join(homeDirectory, "AppData", "Roaming");
  }
  return path.join(homeDirectory, ".local", "share");
}

/** @testonly Owner factory used by architecture-approved application harnesses. */
export function createHostEnvironment(
  values: HostEnvironmentValues,
): HostEnvironment {
  const variables = Object.freeze({ ...values.variables });
  const applicationDataDirectory = getDefaultApplicationDataDirectory(
    values.homeDirectory,
    values.platform,
    variables,
  );

  return Object.freeze({
    currentWorkingDirectory: values.currentWorkingDirectory,
    ...(values.executablePath ? { executablePath: values.executablePath } : {}),
    homeDirectory: values.homeDirectory,
    configHomeDirectory:
      variables.XDG_CONFIG_HOME ??
      (values.platform === "win32"
        ? applicationDataDirectory
        : path.join(values.homeDirectory, ".config")),
    dataHomeDirectory: variables.XDG_DATA_HOME ?? applicationDataDirectory,
    variables,
    platform: values.platform,
    interactive: values.interactive,
  });
}

export function readProcessEnvironment(): HostEnvironment {
  const variables = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const hostUserId = process.getuid?.();
  const hostGroupId = process.getgid?.();
  if (variables.SANDBOX_HOST_UID === undefined && hostUserId !== undefined) {
    variables.SANDBOX_HOST_UID = String(hostUserId);
  }
  if (variables.SANDBOX_HOST_GID === undefined && hostGroupId !== undefined) {
    variables.SANDBOX_HOST_GID = String(hostGroupId);
  }

  return createHostEnvironment({
    currentWorkingDirectory: process.cwd(),
    executablePath: process.execPath,
    homeDirectory: os.homedir(),
    variables,
    platform: os.platform(),
    interactive: process.stdin.isTTY === true,
  });
}
