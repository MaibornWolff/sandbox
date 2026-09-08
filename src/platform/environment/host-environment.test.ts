import { describe, expect, test } from "bun:test";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import { createHostEnvironment } from "./host-environment.js";
import { getHostEnvironment, provideHostEnvironment } from "./index.js";

describe("host environment", () => {
  test("derives isolated Linux roots from explicit values", () => {
    const environment = createHostEnvironment({
      currentWorkingDirectory: "/workspace/project",
      homeDirectory: "/home/tester",
      variables: {
        XDG_CONFIG_HOME: "/isolated/config",
        XDG_DATA_HOME: "/isolated/data",
        SANDBOX_TRUST_ALL: "1",
      },
      platform: "linux",
      interactive: true,
    });

    expect(environment).toEqual({
      currentWorkingDirectory: "/workspace/project",
      homeDirectory: "/home/tester",
      configHomeDirectory: "/isolated/config",
      dataHomeDirectory: "/isolated/data",
      variables: {
        XDG_CONFIG_HOME: "/isolated/config",
        XDG_DATA_HOME: "/isolated/data",
        SANDBOX_TRUST_ALL: "1",
      },
      platform: "linux",
      interactive: true,
    });
  });

  test("resolves only the environment bound to the active scope", () => {
    const environment = createHostEnvironment({
      currentWorkingDirectory: "/isolated/project",
      homeDirectory: "/isolated/home",
      variables: {},
      platform: "linux",
      interactive: false,
    });

    expect(
      runWithDependencies([provideHostEnvironment(environment)], () =>
        getHostEnvironment(),
      ),
    ).toBe(environment);
    expect(() => getHostEnvironment()).toThrow(
      'Dependency "host environment" is not registered in the active scope.',
    );
  });

  test("uses Windows application data as both platform roots", () => {
    const environment = createHostEnvironment({
      currentWorkingDirectory: "C:\\project",
      homeDirectory: "C:\\Users\\tester",
      variables: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
      platform: "win32",
      interactive: false,
    });

    expect(environment.configHomeDirectory).toBe(
      "C:\\Users\\tester\\AppData\\Roaming",
    );
    expect(environment.dataHomeDirectory).toBe(
      "C:\\Users\\tester\\AppData\\Roaming",
    );
  });
});
