import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createSandboxEnvironment,
  provideSandboxEnvironment,
  type SandboxEnvironment,
} from "../sandbox-environment.js";

export interface TestSandboxEnvironment {
  readonly environment: SandboxEnvironment;
  run<T>(operation: () => T): T;
}

export function createTestSandboxEnvironment(
  values: SandboxEnvironment,
): TestSandboxEnvironment {
  const environment = createSandboxEnvironment(values);
  return {
    environment,
    run: (operation) =>
      runWithDependencies([provideSandboxEnvironment(environment)], operation),
  };
}
