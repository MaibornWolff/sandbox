import { describe, expect, test } from "bun:test";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  getSandboxEnvironment,
  provideSandboxEnvironment,
  readSandboxProcessEnvironment,
} from "./sandbox-environment.js";

describe("sandbox process environment", () => {
  test("captures an immutable process snapshot", () => {
    const environment = readSandboxProcessEnvironment();

    expect(environment.filesystemRoot).toBe("/");
    expect(environment.platform).toBeTruthy();
    expect(environment.homeDirectory).toBeTruthy();
    expect(Object.isFrozen(environment)).toBe(true);
    expect(Object.isFrozen(environment.variables)).toBe(true);
  });

  test("provides the captured snapshot to the current application scope", () => {
    const environment = readSandboxProcessEnvironment();

    expect(
      runWithDependencies([provideSandboxEnvironment(environment)], () =>
        getSandboxEnvironment(),
      ),
    ).toBe(environment);
  });
});
