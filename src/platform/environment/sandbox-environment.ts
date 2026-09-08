import * as os from "node:os";
import {
  createDependency,
  type DependencyBinding,
} from "#platform/dependency-injection/index.js";

/** Immutable process and filesystem namespace for sandbox-container-tools. */
export interface SandboxEnvironment {
  readonly filesystemRoot: string;
  readonly homeDirectory: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
}

const sandboxEnvironmentDependency = createDependency<SandboxEnvironment>(
  "sandbox environment",
);

export function provideSandboxEnvironment(
  environment: SandboxEnvironment,
): DependencyBinding {
  return sandboxEnvironmentDependency.provide(environment);
}

export function getSandboxEnvironment(): SandboxEnvironment {
  return sandboxEnvironmentDependency.get();
}

/** @testonly Owner factory used by architecture-approved application harnesses. */
export function createSandboxEnvironment(
  values: SandboxEnvironment,
): SandboxEnvironment {
  return Object.freeze({
    ...values,
    variables: Object.freeze({ ...values.variables }),
  });
}

interface SandboxProcessSnapshot {
  readonly variables: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
}

function createSandboxEnvironmentFromProcessSnapshot(
  snapshot: SandboxProcessSnapshot,
): SandboxEnvironment {
  const variables = Object.fromEntries(
    Object.entries(snapshot.variables).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return createSandboxEnvironment({
    filesystemRoot: "/",
    homeDirectory: variables.HOME ?? snapshot.homeDirectory,
    variables,
    platform: snapshot.platform,
  });
}

export function readSandboxProcessEnvironment(): SandboxEnvironment {
  return createSandboxEnvironmentFromProcessSnapshot({
    variables: process.env,
    homeDirectory: os.homedir(),
    platform: os.platform(),
  });
}
